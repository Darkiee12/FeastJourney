import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Context, Data, Effect, Layer } from "effect";
import sharp from "sharp";
import { z } from "zod";

export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<{}> {}

export class InvalidImage extends Data.TaggedError("InvalidImage")<{ readonly reason: string }> {}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_DIMENSION = 12000;

/** Decoding, orientation and re-encoding strip metadata, EXIF and trailing payloads. */
export const validateMenuImage = (bytes: Uint8Array, declaredType: string) =>
  Effect.tryPromise({
    try: async () => {
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
        throw new InvalidImage({ reason: "Choose an image smaller than 8 MiB." });
      const signature = Buffer.from(bytes.subarray(0, 12));
      let format: "jpeg" | "png" | "webp";

      if (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) format = "jpeg";
      else if (signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        format = "png";
      else if (
        signature.toString("ascii", 0, 4) === "RIFF" &&
        signature.toString("ascii", 8, 12) === "WEBP"
      )
        format = "webp";
      else throw new InvalidImage({ reason: "Choose a JPEG, PNG or WebP photograph." });

      if (declaredType !== `image/${format}`)
        throw new InvalidImage({ reason: "The file contents do not match its image type." });

      const image = sharp(bytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        failOn: "warning",
        animated: false,
      });

      const metadata = await image.metadata();

      if (
        metadata.width > MAX_DIMENSION ||
        metadata.height > MAX_DIMENSION ||
        (metadata.pages ?? 1) !== 1
      )
        throw new InvalidImage({ reason: "Choose one still image no larger than 20 megapixels." });

      const { data, info } = await image
        .rotate()
        .jpeg({ quality: 95 })
        .toBuffer({ resolveWithObject: true });

      if (data.length > MAX_IMAGE_BYTES)
        throw new InvalidImage({ reason: "The decoded image is too large. Crop or resize it." });

      return {
        bytes: data,
        mediaType: "image/jpeg" as const,
        width: info.width,
        height: info.height,
        byteLength: data.length,
        checksum: createHash("sha256").update(data).digest("hex"),
      };
    },
    catch: (error) =>
      error instanceof InvalidImage
        ? error
        : new InvalidImage({
            reason: "This photograph could not be decoded. Choose another image.",
          }),
  });

const storageConfigSchema = z.object({
  S3_ENDPOINT_INTERNAL: z.url(),
  S3_REGION: z.string().min(1).default("garage"),
  S3_BUCKET_PRIVATE: z.string().min(1).default("feastjourney-private"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export class PrivateMenuStorage extends Context.Service<
  PrivateMenuStorage,
  {
    readonly put: (key: string, bytes: Uint8Array) => Effect.Effect<void, StorageUnavailable>;
    readonly read: (key: string) => Effect.Effect<Uint8Array, StorageUnavailable>;
    readonly remove: (key: string) => Effect.Effect<void, StorageUnavailable>;
  }
>()("feastjourney/integrations/PrivateMenuStorage") {}

interface StorageClient {
  readonly client: S3Client;
  readonly bucket: string;
}

/** The Layer owns the lazily created client and releases its connections at shutdown. */
export const PrivateMenuStorageLive = Layer.effect(
  PrivateMenuStorage,
  Effect.gen(function* () {
    let storage: StorageClient | undefined;
    yield* Effect.addFinalizer(() => Effect.sync(() => storage?.client.destroy()));

    const run = <A>(task: (client: S3Client, bucket: string, signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (storage === undefined) {
            const config = storageConfigSchema.parse(process.env);
            storage = {
              client: new S3Client({
                endpoint: config.S3_ENDPOINT_INTERNAL,
                region: config.S3_REGION,
                forcePathStyle: true,
                credentials: {
                  accessKeyId: config.S3_ACCESS_KEY_ID,
                  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
                },
                maxAttempts: 2,
              }),
              bucket: config.S3_BUCKET_PRIVATE,
            };
          }

          return task(
            storage.client,
            storage.bucket,
            AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          );
        },
        catch: () => new StorageUnavailable(),
      });

    return PrivateMenuStorage.of({
      put: (key, bytes) =>
        run(async (client, bucket, signal) => {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              ContentType: "image/jpeg",
            }),
            { abortSignal: signal },
          );
        }),
      read: (key) =>
        run(async (client, bucket, signal) => {
          const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal: signal,
          });

          if (
            object.Body === undefined ||
            (object.ContentLength !== undefined && object.ContentLength > MAX_IMAGE_BYTES)
          )
            throw new StorageUnavailable();
          const reader = object.Body.transformToWebStream().getReader();
          const chunks: Array<Uint8Array> = [];
          let length = 0;

          try {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- A stream must be consumed in order and bounded before allocating.
              const part = await reader.read();

              if (part.done) break;
              const chunk: unknown = part.value;

              if (!(chunk instanceof Uint8Array)) throw new StorageUnavailable();
              length += chunk.byteLength;

              if (length > MAX_IMAGE_BYTES) throw new StorageUnavailable();
              chunks.push(chunk);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }

          if (
            length === 0 ||
            (object.ContentLength !== undefined && length !== object.ContentLength)
          )
            throw new StorageUnavailable();

          return Buffer.concat(chunks);
        }),
      remove: (key) =>
        run(async (client, bucket, signal) => {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal: signal,
          });
        }),
    });
  }),
);
