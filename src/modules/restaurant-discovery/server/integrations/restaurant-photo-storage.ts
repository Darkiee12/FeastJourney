import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Context, Data, Effect, Layer } from "effect";
import { z } from "zod";

export class RestaurantPhotoStorageFailed extends Data.TaggedError("RestaurantPhotoStorageFailed")<{
  readonly operation: string;
  readonly reason: string;
}> {}

export class RestaurantPhotoStorageMisconfigured extends Data.TaggedError(
  "RestaurantPhotoStorageMisconfigured",
)<{
  readonly reason: string;
}> {}

/** Largest stored derivative read: matches the 8 MiB upload ceiling. */
export const MAX_PHOTO_VARIANT_BYTES = 8 * 1024 * 1024;

const storageConfigSchema = z.object({
  S3_ENDPOINT_INTERNAL: z.url(),
  S3_REGION: z.string().min(1).default("garage"),
  S3_BUCKET_PRIVATE: z.string().min(1).default("feastjourney-private"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export class RestaurantPhotoStorage extends Context.Service<
  RestaurantPhotoStorage,
  {
    readonly putVariant: (
      key: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, RestaurantPhotoStorageFailed | RestaurantPhotoStorageMisconfigured>;
    readonly getVariant: (
      key: string,
    ) => Effect.Effect<
      Uint8Array,
      RestaurantPhotoStorageFailed | RestaurantPhotoStorageMisconfigured
    >;
    readonly variantExists: (
      key: string,
    ) => Effect.Effect<boolean, RestaurantPhotoStorageMisconfigured>;
    readonly deleteVariants: (
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<void, RestaurantPhotoStorageMisconfigured>;
  }
>()("feastjourney/restaurant-discovery/RestaurantPhotoStorage") {}

interface StorageClient {
  readonly client: S3Client;
  readonly bucket: string;
}

/**
 * Server-only S3 adapter for first-party venue photography. Reuses the
 * private `feastjourney-private` bucket under the `restaurant-photos/`
 * prefix — never the `menu/` scan prefix or `dish-media/` keys. The Layer
 * owns the lazily created client and releases its connections at shutdown.
 */
export const RestaurantPhotoStorageLive = Layer.effect(
  RestaurantPhotoStorage,
  Effect.gen(function* () {
    let storage: StorageClient | undefined;
    yield* Effect.addFinalizer(() => Effect.sync(() => storage?.client.destroy()));

    const resolveClient = (): StorageClient => {
      if (storage !== undefined) {
        return storage;
      }

      const parsed = storageConfigSchema.safeParse(process.env);

      if (!parsed.success) {
        throw new RestaurantPhotoStorageMisconfigured({
          reason: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }

      storage = {
        client: new S3Client({
          endpoint: parsed.data.S3_ENDPOINT_INTERNAL,
          region: parsed.data.S3_REGION,
          forcePathStyle: true,
          credentials: {
            accessKeyId: parsed.data.S3_ACCESS_KEY_ID,
            secretAccessKey: parsed.data.S3_SECRET_ACCESS_KEY,
          },
          maxAttempts: 2,
        }),
        bucket: parsed.data.S3_BUCKET_PRIVATE,
      };

      return storage;
    };

    const run = <A>(
      operation: string,
      task: (client: S3Client, bucket: string, signal: AbortSignal) => Promise<A>,
    ): Effect.Effect<A, RestaurantPhotoStorageFailed | RestaurantPhotoStorageMisconfigured> =>
      Effect.tryPromise({
        try: async (signal) => {
          const resolved = resolveClient();

          return task(
            resolved.client,
            resolved.bucket,
            AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          );
        },
        catch: (cause) =>
          cause instanceof RestaurantPhotoStorageMisconfigured ||
          cause instanceof RestaurantPhotoStorageFailed
            ? cause
            : new RestaurantPhotoStorageFailed({
                operation,
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
      });

    return RestaurantPhotoStorage.of({
      putVariant: (key, bytes) =>
        run("put", async (client, bucket, signal) => {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              ContentType: "image/webp",
            }),
            { abortSignal: signal },
          );
        }),
      getVariant: (key) =>
        run("get", async (client, bucket, signal) => {
          const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal: signal,
          });

          if (
            object.Body === undefined ||
            (object.ContentLength !== undefined && object.ContentLength > MAX_PHOTO_VARIANT_BYTES)
          ) {
            throw new RestaurantPhotoStorageFailed({
              operation: "get",
              reason: "empty or oversized object body",
            });
          }

          // Bounded stream consumption: the reader stops at the variant
          // ceiling even when ContentLength is absent or lies.
          const reader = object.Body.transformToWebStream().getReader();
          const chunks: Array<Uint8Array> = [];
          let length = 0;

          try {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- A stream must be consumed in order and bounded before allocating.
              const part = await reader.read();

              if (part.done) break;
              const chunk: unknown = part.value;

              if (!(chunk instanceof Uint8Array)) {
                throw new RestaurantPhotoStorageFailed({
                  operation: "get",
                  reason: "unexpected stream chunk",
                });
              }

              length += chunk.byteLength;

              if (length > MAX_PHOTO_VARIANT_BYTES) {
                throw new RestaurantPhotoStorageFailed({
                  operation: "get",
                  reason: "object exceeds the variant byte ceiling",
                });
              }

              chunks.push(chunk);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }

          if (
            length === 0 ||
            (object.ContentLength !== undefined && length !== object.ContentLength)
          ) {
            throw new RestaurantPhotoStorageFailed({
              operation: "get",
              reason: "truncated object body",
            });
          }

          return Buffer.concat(chunks);
        }),
      variantExists: (key) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = resolveClient();

            try {
              await resolved.client.send(
                new HeadObjectCommand({ Bucket: resolved.bucket, Key: key }),
              );

              return true;
            } catch {
              return false;
            }
          },
          catch: (cause) =>
            cause instanceof RestaurantPhotoStorageMisconfigured
              ? cause
              : new RestaurantPhotoStorageMisconfigured({ reason: String(cause) }),
        }),
      deleteVariants: (keys) =>
        Effect.tryPromise({
          try: async () => {
            if (keys.length === 0) {
              return;
            }

            const resolved = resolveClient();

            // Best-effort withdrawal: object removal must never fail the DB
            // delete that already revoked public visibility.
            try {
              await resolved.client.send(
                new DeleteObjectsCommand({
                  Bucket: resolved.bucket,
                  Delete: { Objects: keys.map((Key) => ({ Key })) },
                }),
              );
            } catch {
              return;
            }
          },
          catch: (cause) =>
            cause instanceof RestaurantPhotoStorageMisconfigured
              ? cause
              : new RestaurantPhotoStorageMisconfigured({ reason: String(cause) }),
        }),
    });
  }),
);
