import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import postgres from "postgres";
import sharp from "sharp";
import { z } from "zod";

// oxlint-disable-next-line import/no-unassigned-import -- disposable-DB guard + test env defaults; this file owns no fixtures.
import "./cleanup";
import {
  parseStageUploadForm,
  restaurantPhotoImageResponse,
} from "@/modules/restaurant-discovery/restaurant-photos.functions";
import {
  previewRestaurantPhotoSchema,
  reorderRestaurantPhotosSchema,
  restaurantPhotoAdminListSchema,
  restaurantPhotoAdminSchema,
  restaurantPhotoReviewQueueSchema,
  stageRestaurantPhotoFieldsSchema,
  updateRestaurantPhotoMetadataSchema,
} from "@/modules/restaurant-discovery/restaurant-photos.schema";
import {
  RestaurantPhotoStorage,
  RestaurantPhotoStorageFailed,
} from "@/modules/restaurant-discovery/server/integrations/restaurant-photo-storage";
import { RestaurantNotFound } from "@/modules/restaurant-discovery/server/operations/discovery";
import {
  RestaurantPhotoConflict,
  RestaurantPhotoLimitExceeded,
  RestaurantPhotoNotFound,
  RestaurantPhotoPublishBlocked,
  type RestaurantPhotoRepository,
  RestaurantPhotoRepositoryLive,
  RestaurantPhotoService,
  RestaurantPhotoServiceLive,
  RestaurantPhotoValidationFailed,
  type RestaurantPhotoAdminView,
} from "@/modules/restaurant-discovery/server/operations/photos";
import { UserRepositoriesLive } from "@/modules/user/server/index";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { withActor, type CurrentActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { Permission, PermissionRequest } from "@/server/auth/permissions";
import type { Database } from "@/server/database/client";
import { DatabaseLive } from "@/server/database/client";

/**
 * Browser transport contract for venue photography: Zod boundary schemas,
 * the multipart upload parser, the binary image response, and the Effect
 * service driven through the exact wiring the server functions use
 * (member actor + provided photo layers), with the strict transport
 * projection applied to every response.
 *
 * Needs the disposable database (guarded by `./cleanup`) and runs the real
 * repository against it with an in-memory object store and a stubbed
 * Authorization. Live Garage round-trips stay in `tests/restaurant-photos.test.ts`.
 */

const photoBytes = async (
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" = "jpeg",
): Promise<Uint8Array> => {
  const canvas = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 180 } },
  });

  if (format === "jpeg") return new Uint8Array(await canvas.jpeg().toBuffer());

  if (format === "png") return new Uint8Array(await canvas.png().toBuffer());

  return new Uint8Array(await canvas.webp().toBuffer());
};

interface FakeWorld {
  readonly objects: Map<string, Uint8Array>;
  readonly venueId: string;
  readonly denyReview: boolean;
  readonly denyAll: boolean;
  readonly failPut: boolean;
}

const sql = postgres(process.env["DATABASE_URL"] ?? "", { max: 2 });

const FIXTURE_PREFIX = `photo-api-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const fixtureRowSchema = z.array(z.object({ id: z.string() }));

let fixtureBusinessId = "";
let fixtureVenueIds: Array<string> = [];
let fixtureVenueIndex = 0;

const takeVenueId = (): string => {
  const venueId = fixtureVenueIds[fixtureVenueIndex];

  fixtureVenueIndex += 1;

  if (venueId === undefined)
    throw new Error("out of fixture venues for restaurant-photo-api tests");

  return venueId;
};

let savedPoolMax: string | undefined;

beforeAll(async () => {
  // Each runService call builds a file-local runtime with its own Database
  // pool. Cap at 2 connections so sequential create/dispose cycles never
  // stack pools against the disposable Postgres max_connections budget.
  savedPoolMax = process.env["DATABASE_POOL_MAX"];
  process.env["DATABASE_POOL_MAX"] = "2";

  const business = await sql`INSERT INTO feastjourney.restaurant_businesses (name)
    VALUES (${`${FIXTURE_PREFIX} business`}) RETURNING id::text AS id`;

  const businessId = fixtureRowSchema.parse(business)[0]?.id;

  if (businessId === undefined) throw new Error("fixture business insert returned no id");

  fixtureBusinessId = businessId;

  const venues: Array<string> = [];

  for (let n = 1; n <= 24; n += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Fixture setup runs once per file; sequential inserts keep ids deterministic.
    const inserted = await sql`INSERT INTO feastjourney.restaurant_venues
      (business_id, name, address, area, country_code, location)
      VALUES (${fixtureBusinessId}::uuid, ${`${FIXTURE_PREFIX} venue ${n}`},
        ${`${FIXTURE_PREFIX} address ${n}`}, ${`${FIXTURE_PREFIX} area`}, 'VN',
        ST_GeogFromText('SRID=4326;POINT(106.66 10.77)'))
      RETURNING id::text AS id`;

    const venueId = fixtureRowSchema.parse(inserted)[0]?.id;

    if (venueId === undefined) throw new Error("fixture venue insert returned no id");

    venues.push(venueId);
  }

  fixtureVenueIds = venues;
});

afterAll(async () => {
  await sql`DELETE FROM feastjourney.restaurant_photos WHERE venue_id IN (
    SELECT id FROM feastjourney.restaurant_venues WHERE business_id = ${fixtureBusinessId}::uuid)`;
  await sql`DELETE FROM feastjourney.restaurant_venues WHERE business_id = ${fixtureBusinessId}::uuid`;
  await sql`DELETE FROM feastjourney.restaurant_businesses WHERE id = ${fixtureBusinessId}::uuid`;
  await sql.end();

  if (savedPoolMax === undefined) {
    delete process.env["DATABASE_POOL_MAX"];
  } else {
    process.env["DATABASE_POOL_MAX"] = savedPoolMax;
  }
});

const testLayers = (world: FakeWorld) => {
  const storage = Layer.succeed(RestaurantPhotoStorage, {
    putVariant: (key: string, bytes: Uint8Array) => {
      if (world.failPut) {
        return Effect.fail(
          new RestaurantPhotoStorageFailed({ operation: "put", reason: "injected failure" }),
        );
      }

      world.objects.set(key, bytes);

      return Effect.void;
    },
    getVariant: (key: string) => {
      const bytes = world.objects.get(key);

      if (bytes === undefined) {
        return Effect.fail(
          new RestaurantPhotoStorageFailed({ operation: "get", reason: "missing object" }),
        );
      }

      return Effect.succeed(bytes);
    },
    variantExists: (key: string) => Effect.succeed(world.objects.has(key)),
    deleteVariants: (keys: ReadonlyArray<string>) => {
      for (const key of keys) world.objects.delete(key);

      return Effect.void;
    },
  });

  const authorization = Layer.succeed(Authorization, {
    permissionsOf: () => Effect.succeed(new Set<Permission>()),
    has: () => Effect.succeed(true),
    require: (_actor: Actor, request: PermissionRequest) => {
      if (world.denyAll) return Effect.fail(new InsufficientPermissions({ reason: "denied" }));

      const actions: ReadonlyArray<string> = request.actions;

      if (world.denyReview && actions.includes("review")) {
        return Effect.fail(new InsufficientPermissions({ reason: "Missing restaurant:review." }));
      }

      return Effect.void;
    },
    requireManageableRole: () =>
      Effect.fail(new InsufficientPermissions({ reason: "not manageable" })),
    requireDelegatable: () => Effect.void,
  });

  return Layer.mergeAll(RestaurantPhotoRepositoryLive, storage, authorization);
};

type ServiceEnv =
  | RestaurantPhotoService
  | RestaurantPhotoRepository
  | RestaurantPhotoStorage
  | CurrentActor
  | Authorization
  | RoleRepository
  | UserRepository
  | Database;

const runService = async <A, E>(
  world: FakeWorld,
  effect: Effect.Effect<A, E, ServiceEnv>,
  actor: Actor = Actor.Member({ userId: "test-member" }),
): Promise<A> => {
  const deps = testLayers(world);
  const serviceLive = Layer.provide(RestaurantPhotoServiceLive, deps);
  // File-local runtime: the shared appRuntime memoizes the live S3 storage
  // layer, which would bypass the in-memory stub. This runtime never
  // includes the live storage, so every put/get/delete hits world.objects.
  // UserRepositoriesLive supplies the real Role/User repositories (backed by
  // the disposable DB) for audit paths in publish/withdraw/remove.

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DatabaseLive, UserRepositoriesLive, deps, serviceLive),
  );

  try {
    return await runtime.runPromise(withActor(actor, effect));
  } finally {
    await runtime.dispose();
  }
};

const captureFailure = async <A, E>(
  world: FakeWorld,
  effect: Effect.Effect<A, E, ServiceEnv>,
  actor: Actor = Actor.Member({ userId: "test-member" }),
) => {
  const deps = testLayers(world);
  const serviceLive = Layer.provide(RestaurantPhotoServiceLive, deps);

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DatabaseLive, UserRepositoriesLive, deps, serviceLive),
  );

  try {
    const exit = await runtime.runPromiseExit(withActor(actor, effect));

    if (Exit.isSuccess(exit)) throw new Error("expected a failure");

    const failure = Cause.findErrorOption(exit.cause);

    if (Option.isNone(failure)) throw new Error("expected a typed failure");

    return failure.value;
  } finally {
    await runtime.dispose();
  }
};

/** Transport projection applied exactly as the server functions apply it. */
const asTransported = (view: RestaurantPhotoAdminView) => restaurantPhotoAdminSchema.parse(view);

const stageValidPhoto = async (
  world: FakeWorld,
  overrides?: Partial<{
    readonly altText: string | null;
    readonly attribution: string | null;
    readonly license: string;
    readonly makePrimary: boolean;
  }>,
) => {
  const bytes = await photoBytes(1200, 800);

  return runService(
    world,
    Effect.flatMap(RestaurantPhotoService, (service) =>
      service.stagePhoto({
        venueId: world.venueId,
        bytes,
        filename: "venue.jpg",
        altText: overrides?.altText ?? "Sunlit dining room with wooden tables",
        attribution: overrides?.attribution ?? "Test photographer",
        license: overrides?.license ?? "own-work",
        focalX: null,
        focalY: null,
        sourceUrl: null,
        makePrimary: overrides?.makePrimary ?? false,
      }),
    ),
  );
};

const submitEffect = (photoId: string) =>
  Effect.flatMap(RestaurantPhotoService, (service) => service.submitForReview(photoId));

const publishEffect = (photoId: string) =>
  Effect.flatMap(RestaurantPhotoService, (service) => service.publishPhoto(photoId));

const servePublicEffect = (photoId: string) =>
  Effect.flatMap(RestaurantPhotoService, (service) =>
    service.serveDerivative({ photoId, version: 1, width: 800, preview: false }),
  );

const uploadForm = (file: File | null, fields: Record<string, string>): FormData => {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  if (file !== null) form.set("file", file);

  return form;
};

/** Fresh ArrayBuffer-backed copy: File parts need a resizable detached-safe buffer. */
const filePart = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const photoFile = (bytes: Uint8Array, name = "venue.jpg"): File =>
  new File([filePart(bytes)], name, { type: "image/jpeg" });

const parseUploadFailure = async (form: FormData): Promise<RestaurantPhotoValidationFailed> => {
  try {
    await parseStageUploadForm(form);
  } catch (error) {
    if (error instanceof RestaurantPhotoValidationFailed) return error;

    throw error;
  }

  throw new Error("expected upload parsing to fail");
};

describe("transport schemas", () => {
  test("venue and id inputs require UUIDs", () => {
    expect(() => previewRestaurantPhotoSchema.parse({ photoId: "nope" })).toThrow();
    expect(() =>
      reorderRestaurantPhotosSchema.parse({ venueId: "nope", orderedIds: [] }),
    ).toThrow();
  });

  test("metadata bounds match the service contract", () => {
    const base = {
      photoId: crypto.randomUUID(),
      altText: null,
      attribution: null,
      license: "own-work",
      focalX: null,
      focalY: null,
      sourceUrl: null,
    };

    expect(updateRestaurantPhotoMetadataSchema.parse(base).license).toBe("own-work");
    expect(updateRestaurantPhotoMetadataSchema.parse({ ...base, license: "unknown" }).license).toBe(
      "unknown",
    );
    expect(() => updateRestaurantPhotoMetadataSchema.parse({ ...base, license: "pd" })).toThrow();
    expect(() =>
      updateRestaurantPhotoMetadataSchema.parse({ ...base, altText: "x".repeat(501) }),
    ).toThrow();
    expect(() => updateRestaurantPhotoMetadataSchema.parse({ ...base, focalX: 2 })).toThrow();
    expect(() =>
      updateRestaurantPhotoMetadataSchema.parse({ ...base, sourceUrl: "http://x.test/p.jpg" }),
    ).toThrow();
    expect(
      updateRestaurantPhotoMetadataSchema.parse({ ...base, sourceUrl: "https://x.test/p.jpg" })
        .sourceUrl,
    ).toBe("https://x.test/p.jpg");
  });

  test("reorder caps at five ids and queue pages are bounded", () => {
    const venueId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];

    expect(reorderRestaurantPhotosSchema.parse({ venueId, orderedIds: ids }).orderedIds).toEqual(
      ids,
    );
    expect(() => reorderRestaurantPhotosSchema.parse({ venueId, orderedIds: [] })).toThrow();
    expect(() =>
      reorderRestaurantPhotosSchema.parse({ venueId, orderedIds: [crypto.randomUUID()] }),
    ).not.toThrow();
    expect(restaurantPhotoReviewQueueSchema.parse({}).limit).toBe(20);
    expect(() => restaurantPhotoReviewQueueSchema.parse({ limit: 101 })).toThrow();
    expect(() => restaurantPhotoReviewQueueSchema.parse({ offset: -1 })).toThrow();
  });

  test("preview widths are allowlisted and stage fields default makePrimary", () => {
    const photoId = crypto.randomUUID();

    expect(previewRestaurantPhotoSchema.parse({ photoId }).width).toBe(800);
    expect(previewRestaurantPhotoSchema.parse({ photoId, width: 400 }).width).toBe(400);
    expect(() => previewRestaurantPhotoSchema.parse({ photoId, width: 200 })).toThrow();
    expect(() => previewRestaurantPhotoSchema.parse({ photoId, version: 0 })).toThrow();
    expect(
      stageRestaurantPhotoFieldsSchema.parse({
        venueId: crypto.randomUUID(),
        altText: null,
        attribution: null,
        license: "own-work",
        focalX: null,
        focalY: null,
        sourceUrl: null,
      }).makePrimary,
    ).toBe(false);
  });

  test("strict admin projection rejects storage internals", () => {
    const view = {
      id: crypto.randomUUID(),
      venueId: crypto.randomUUID(),
      status: "draft",
      sortOrder: 0,
      isPrimary: true,
      altText: null,
      attribution: null,
      license: "own-work",
      focalX: null,
      focalY: null,
      originalWidth: 1200,
      originalHeight: 800,
      format: "jpeg",
      byteSize: 100,
      processing: "ready",
      variantVersion: 1,
      uploadedBy: null,
      reviewedAt: null,
      publishedAt: null,
      sourceUrl: null,
      deliveryUrl: null,
      srcSet: null,
      previewUrl: null,
      createdAt: null,
      updatedAt: null,
      object_key: "restaurant-photos/v/p/1/400.webp",
      checksum_sha256: "abc",
    };

    expect(() => restaurantPhotoAdminSchema.parse(view)).toThrow();
    expect(restaurantPhotoAdminListSchema.parse([])).toEqual([]);
  });
});

describe("multipart upload boundary", () => {
  test("accepts a valid photo part with text fields", async () => {
    const bytes = await photoBytes(1200, 800);

    const form = uploadForm(photoFile(bytes), {
      venueId: crypto.randomUUID(),
      altText: "Dining room",
      license: "cc-by",
      makePrimary: "true",
    });

    const parsed = await parseStageUploadForm(form);

    expect(parsed.filename).toBe("venue.jpg");
    expect(parsed.bytes.byteLength).toBe(bytes.byteLength);
    expect(parsed.fields.altText).toBe("Dining room");
    expect(parsed.fields.makePrimary).toBe(true);
    expect(parsed.fields.attribution).toBeNull();
  });

  test("rejects a missing file part", async () => {
    const form = uploadForm(null, { venueId: crypto.randomUUID() });

    expect(await parseUploadFailure(form)).toBeInstanceOf(RestaurantPhotoValidationFailed);
  });

  test("rejects oversized files before reading bytes", async () => {
    const big = new File([new Uint8Array(new ArrayBuffer(8 * 1024 * 1024 + 1))], "big.jpg", {
      type: "image/jpeg",
    });

    const form = uploadForm(big, { venueId: crypto.randomUUID() });

    expect(await parseUploadFailure(form)).toBeInstanceOf(RestaurantPhotoValidationFailed);
  });

  test("rejects invalid venue, focal, source, and license at the boundary", async () => {
    const bytes = await photoBytes(1200, 800);
    const file = () => photoFile(bytes);

    expect(await parseUploadFailure(uploadForm(file(), { venueId: "nope" }))).toBeInstanceOf(
      RestaurantPhotoValidationFailed,
    );
    expect(
      await parseUploadFailure(uploadForm(file(), { venueId: crypto.randomUUID(), focalX: "9" })),
    ).toBeInstanceOf(RestaurantPhotoValidationFailed);
    expect(
      await parseUploadFailure(
        uploadForm(file(), { venueId: crypto.randomUUID(), sourceUrl: "http://x.test/p.jpg" }),
      ),
    ).toBeInstanceOf(RestaurantPhotoValidationFailed);
    expect(
      await parseUploadFailure(uploadForm(file(), { venueId: crypto.randomUUID(), license: "pd" })),
    ).toBeInstanceOf(RestaurantPhotoValidationFailed);
  });
});

describe("binary image response", () => {
  const derivative = {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/webp" as const,
    etag: '"rp-x-v1-800"',
    byteSize: 3,
  };

  test("published derivatives are immutable and public", async () => {
    const response = restaurantPhotoImageResponse(derivative, {
      preview: false,
      ifNoneMatch: null,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("ETag")).toBe('"rp-x-v1-800"');
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("matching ETag short-circuits published derivatives", () => {
    const response = restaurantPhotoImageResponse(derivative, {
      preview: false,
      ifNoneMatch: '"rp-x-v1-800"',
    });

    expect(response.status).toBe(304);
  });

  test("previews are never cached and never 304", () => {
    const response = restaurantPhotoImageResponse(derivative, {
      preview: true,
      ifNoneMatch: '"rp-x-v1-800"',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("authz matrix per operation", () => {
  test("guests cannot stage, edit, reorder, submit, publish, withdraw, or delete", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const staged = await stageValidPhoto(world);

    const guest = Actor.Guest();
    const bytes = await photoBytes(1200, 800);

    const stageFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes,
          filename: "venue.jpg",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
      guest,
    );

    expect(stageFailure).toBeInstanceOf(InsufficientPermissions);

    const metadataFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.updateMetadata({
          photoId: staged.id,
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
        }),
      ),
      guest,
    );

    expect(metadataFailure).toBeInstanceOf(InsufficientPermissions);

    const reorderFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.reorderPhotos({ venueId: world.venueId, orderedIds: [staged.id] }),
      ),
      guest,
    );

    expect(reorderFailure).toBeInstanceOf(InsufficientPermissions);

    const submitFailure = await captureFailure(world, submitEffect(staged.id), guest);

    expect(submitFailure).toBeInstanceOf(InsufficientPermissions);

    const publishFailure = await captureFailure(world, publishEffect(staged.id), guest);

    expect(publishFailure).toBeInstanceOf(InsufficientPermissions);

    const withdrawFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.returnToDraft(staged.id)),
      guest,
    );

    expect(withdrawFailure).toBeInstanceOf(InsufficientPermissions);

    const removeFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.removePhoto(staged.id)),
      guest,
    );

    expect(removeFailure).toBeInstanceOf(InsufficientPermissions);
  });

  test("members without any grant fail every protected operation", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: true,
      failPut: false,
    };

    const bytes = await photoBytes(1200, 800);

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes,
          filename: "venue.jpg",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);

    const listFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.listForAdmin(world.venueId)),
    );

    expect(listFailure).toBeInstanceOf(InsufficientPermissions);
  });

  test("manage holders cannot publish or read the review queue without the review grant", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: true,
      denyAll: false,
      failPut: false,
    };

    const staged = await stageValidPhoto({ ...world, denyReview: false });
    const reviewed = await runService({ ...world, denyReview: false }, submitEffect(staged.id));

    const queueFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.listReviewQueue(20)),
    );

    expect(queueFailure).toBeInstanceOf(InsufficientPermissions);

    const publishFailure = await captureFailure(world, publishEffect(reviewed.id));

    expect(publishFailure).toBeInstanceOf(InsufficientPermissions);
  });

  test("removing a published photo needs the review grant; drafts need only manage", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const staged = await stageValidPhoto(world);
    const reviewed = await runService(world, submitEffect(staged.id));
    const published = await runService(world, publishEffect(reviewed.id));

    const denied: FakeWorld = { ...world, denyReview: true };

    const publishedFailure = await captureFailure(
      denied,
      Effect.flatMap(RestaurantPhotoService, (service) => service.removePhoto(published.id)),
    );

    expect(publishedFailure).toBeInstanceOf(InsufficientPermissions);

    const draft = await stageValidPhoto(world);

    const removed = await runService(
      denied,
      Effect.flatMap(RestaurantPhotoService, (service) => service.removePhoto(draft.id)),
    );

    expect(removed.id).toBe(draft.id);
    expect(removed.venueId).toBe(world.venueId);
  });
});

describe("upload validation through the service", () => {
  test("oversized, unsupported, and undersized uploads are rejected", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const oversized = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes: new Uint8Array(8 * 1024 * 1024 + 1),
          filename: "big.jpg",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(oversized).toBeInstanceOf(RestaurantPhotoValidationFailed);

    const gif = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 59]),
          filename: "venue.gif",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(gif).toBeInstanceOf(RestaurantPhotoValidationFailed);

    const tiny = await photoBytes(300, 300);

    const dimensionFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes: tiny,
          filename: "venue.jpg",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(dimensionFailure).toBeInstanceOf(RestaurantPhotoValidationFailed);
  });

  test("unknown venues and the sixth photo are rejected", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const bytes = await photoBytes(1200, 800);

    const unknownFailure = await captureFailure(
      { ...world, venueId: crypto.randomUUID() },
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: crypto.randomUUID(),
          bytes,
          filename: "venue.jpg",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(unknownFailure).toBeInstanceOf(RestaurantNotFound);

    for (let index = 0; index < 5; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential staging keeps sort-order allocation deterministic per venue.
      await stageValidPhoto(world);
    }

    const capFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes,
          filename: "extra.jpg",
          altText: "Extra",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(capFailure).toBeInstanceOf(RestaurantPhotoLimitExceeded);
  });

  test("storage failure leaves no public or inconsistent rows", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: true,
    };

    const bytes = await photoBytes(1200, 800);

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes,
          filename: "venue.jpg",
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: null,
          makePrimary: false,
        }),
      ),
    );

    expect(failure).toBeInstanceOf(RestaurantPhotoStorageFailed);

    const listed = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.listForAdmin(world.venueId)),
    );

    expect(listed.filter((view) => view.processing === "ready")).toEqual([]);
  });
});

describe("publication lifecycle through the transport projection", () => {
  test("drafts and review items never serve publicly", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const staged = await stageValidPhoto(world);

    expect(asTransported(staged).deliveryUrl).toBeNull();

    const draftFailure = await captureFailure(world, servePublicEffect(staged.id), Actor.Guest());

    expect(draftFailure).toBeInstanceOf(RestaurantPhotoNotFound);

    const reviewed = await runService(world, submitEffect(staged.id));

    expect(asTransported(reviewed).deliveryUrl).toBeNull();

    const reviewFailure = await captureFailure(
      world,
      servePublicEffect(reviewed.id),
      Actor.Guest(),
    );

    expect(reviewFailure).toBeInstanceOf(RestaurantPhotoNotFound);
  });

  test("missing derivatives cannot publish", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const staged = await stageValidPhoto(world);
    const reviewed = await runService(world, submitEffect(staged.id));

    world.objects.clear();

    const failure = await captureFailure(world, publishEffect(reviewed.id));

    expect(failure).toBeInstanceOf(RestaurantPhotoPublishBlocked);
  });

  test("withdrawal revokes public delivery while keeping the audit trail", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const staged = await stageValidPhoto(world);
    const reviewed = await runService(world, submitEffect(staged.id));
    const published = await runService(world, publishEffect(reviewed.id));

    expect(asTransported(published).deliveryUrl).toContain("/api/v1/restaurant-images/");

    const draft = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.returnToDraft(published.id)),
    );

    expect(asTransported(draft).deliveryUrl).toBeNull();
    expect(asTransported(draft).status).toBe("draft");

    const publicFailure = await captureFailure(
      world,
      servePublicEffect(published.id),
      Actor.Guest(),
    );

    expect(publicFailure).toBeInstanceOf(RestaurantPhotoNotFound);

    const rows = await sql`SELECT event FROM feastjourney.security_audit_events
      WHERE resource = ${published.id} AND event = 'restaurant.photo.withdrawn'`;

    expect(rows.length).toBe(1);
  });

  test("reorder follows the exact set and the transport keeps display order", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    const first = await stageValidPhoto(world);
    const second = await stageValidPhoto(world);

    const reordered = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.reorderPhotos({ venueId: world.venueId, orderedIds: [second.id, first.id] }),
      ),
    );

    const transported = restaurantPhotoAdminListSchema.parse(reordered);

    expect(transported.map((view) => view.id)).toEqual([second.id, first.id]);
    expect(transported[0]?.isPrimary).toBe(true);
    expect(transported[1]?.isPrimary).toBe(false);

    const partialFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.reorderPhotos({ venueId: world.venueId, orderedIds: [first.id] }),
      ),
    );

    expect(partialFailure).toBeInstanceOf(RestaurantPhotoConflict);
  });

  test("private scan keys are never resolvable through photo delivery", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
      failPut: false,
    };

    await stageValidPhoto(world);

    for (const key of world.objects.keys()) {
      expect(key.startsWith("restaurant-photos/")).toBe(true);
      expect(key).not.toContain("menu/");
      expect(key).not.toContain("dish-media");
    }

    // Delivery resolves photo ids to versioned restaurant-photos/ keys from
    // the database row — private menu-scan keys are not addressable here.
    const unknownFailure = await captureFailure(
      world,
      servePublicEffect(crypto.randomUUID()),
      Actor.Guest(),
    );

    expect(unknownFailure).toBeInstanceOf(RestaurantPhotoNotFound);

    const guestPreviewFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({
          photoId: crypto.randomUUID(),
          version: 1,
          width: 800,
          preview: true,
        }),
      ),
      Actor.Guest(),
    );

    expect(guestPreviewFailure).toBeInstanceOf(RestaurantPhotoNotFound);
  });
});
