import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Layer, Option } from "effect";
import postgres from "postgres";
import sharp from "sharp";
import { z } from "zod";

import {
  RestaurantPhotoStorage,
  RestaurantPhotoStorageFailed,
  RestaurantPhotoStorageLive,
} from "@/modules/restaurant-discovery/server/integrations/restaurant-photo-storage";
import { RestaurantNotFound } from "@/modules/restaurant-discovery/server/operations/discovery";
import {
  MAX_PHOTOS_PER_VENUE,
  processRestaurantPhotoImage,
  RestaurantPhotoConflict,
  RestaurantPhotoLimitExceeded,
  RestaurantPhotoNotFound,
  RestaurantPhotoPublishBlocked,
  type RestaurantPhotoRepository,
  RestaurantPhotoRepositoryLive,
  RestaurantPhotoService,
  RestaurantPhotoServiceLive,
  RestaurantPhotoValidationFailed,
} from "@/modules/restaurant-discovery/server/operations/photos";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { withActor, type CurrentActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { Permission, PermissionRequest } from "@/server/auth/permissions";
import type { Database } from "@/server/database/client";
import { appRuntime } from "@/server/runtime";

/**
 * Venue photography: image pipeline validation plus storage/publication
 * rules. The image pipeline is pure over bytes (no DB, no S3); the rule
 * suite runs the real RestaurantPhotoService against the real repository
 * and disposable database with an in-memory object store and a stubbed
 * Authorization. Live Garage round-trips are covered by the disposable
 * prefix test at the bottom of this file, skipped without S3 env.
 */

const photoBytes = async (
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" = "jpeg",
): Promise<Uint8Array> => {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 180 } },
  });

  if (format === "jpeg") {
    return new Uint8Array(await base.jpeg().toBuffer());
  }

  if (format === "png") {
    return new Uint8Array(await base.png().toBuffer());
  }

  return new Uint8Array(await base.webp().toBuffer());
};

const isWebP = (bytes: Uint8Array): boolean =>
  bytes.length > 12 &&
  bytes[0] === 0x52 &&
  bytes[1] === 0x49 &&
  bytes[2] === 0x46 &&
  bytes[3] === 0x46 &&
  bytes[8] === 0x57 &&
  bytes[9] === 0x45 &&
  bytes[10] === 0x42 &&
  bytes[11] === 0x50;

const validationReason = async (task: Promise<unknown>): Promise<string> => {
  try {
    await task;
  } catch (error) {
    if (error instanceof RestaurantPhotoValidationFailed) {
      return error.reason;
    }

    throw error;
  }

  throw new Error("expected a validation failure");
};

describe("restaurant photo image pipeline", () => {
  test("accepts a valid JPEG and emits three WebP derivatives", async () => {
    const processed = await processRestaurantPhotoImage(await photoBytes(1200, 800), "venue.jpg");

    expect(processed.format).toBe("jpeg");
    expect(processed.width).toBe(1200);
    expect(processed.height).toBe(800);
    expect(processed.variants).toHaveLength(3);
    expect(processed.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    for (const variant of processed.variants) {
      expect(isWebP(variant.bytes)).toBe(true);
    }

    const widths = processed.variants.map((variant) => variant.width);

    expect(widths).toEqual([400, 800, 1600]);
  });

  test("accepts PNG sources", async () => {
    const processed = await processRestaurantPhotoImage(
      await photoBytes(900, 700, "png"),
      "venue.png",
    );

    expect(processed.format).toBe("png");

    for (const variant of processed.variants) {
      expect(isWebP(variant.bytes)).toBe(true);
    }
  });

  test("accepts WebP sources", async () => {
    const processed = await processRestaurantPhotoImage(
      await photoBytes(1000, 800, "webp"),
      "venue.webp",
    );

    expect(processed.format).toBe("webp");
  });

  test("rejects SVG by extension even though the container parses", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"></svg>',
    );

    expect(await validationReason(processRestaurantPhotoImage(svg, "venue.svg"))).toMatch(
      /not accepted/,
    );
  });

  test("rejects GIF content", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 59]);

    expect(await validationReason(processRestaurantPhotoImage(gif, "venue.gif"))).toMatch(
      /not accepted/,
    );
  });

  test("rejects HEIC filenames", async () => {
    const bytes = await photoBytes(800, 700);

    expect(await validationReason(processRestaurantPhotoImage(bytes, "venue.heic"))).toMatch(
      /not accepted/,
    );
  });

  test("rejects corrupt bytes", async () => {
    const corrupt = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

    expect(await validationReason(processRestaurantPhotoImage(corrupt, "venue.png"))).toMatch(
      /not.*readable/,
    );
  });

  test("rejects empty uploads", async () => {
    expect(
      await validationReason(processRestaurantPhotoImage(new Uint8Array(0), "venue.jpg")),
    ).toMatch(/empty file/);
  });

  test("rejects payloads above 8 MiB without decoding", async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);

    expect(await validationReason(processRestaurantPhotoImage(oversized, "venue.jpg"))).toMatch(
      /8 MiB/,
    );
  });

  test("rejects images whose shortest side is under 600px", async () => {
    expect(
      await validationReason(processRestaurantPhotoImage(await photoBytes(1200, 400), "wide.jpg")),
    ).toMatch(/shortest side/);
  });

  test("rejects images above 24 megapixels", async () => {
    expect(
      await validationReason(processRestaurantPhotoImage(await photoBytes(6000, 5000), "huge.jpg")),
    ).toMatch(/24 megapixels/);
  });

  test("never upscales small-but-valid sources", async () => {
    const processed = await processRestaurantPhotoImage(await photoBytes(700, 650), "small.jpg");

    const widths = await Promise.all(
      processed.variants.map(async (variant) => {
        const metadata = await sharp(variant.bytes).metadata();

        return metadata.width;
      }),
    );

    for (const width of widths) {
      expect(width).toBeLessThanOrEqual(700);
    }
  });

  test("applies EXIF orientation to reported dimensions", async () => {
    const oriented = new Uint8Array(
      await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );

    const processed = await processRestaurantPhotoImage(oriented, "rotated.jpg");

    expect(processed.width).toBe(600);
    expect(processed.height).toBe(800);
  });

  test("sniffs content, not filenames", async () => {
    const processed = await processRestaurantPhotoImage(await photoBytes(800, 700), "no-extension");

    expect(processed.format).toBe("jpeg");
  });
});

// ---------------------------------------------------------------------------
// Service rule suite (real repository + disposable database, in-memory
// object store, stubbed Authorization). Every staged photo runs through the
// real Sharp pipeline and the real staged finalize, so storage, review, and
// publication rules execute against production code paths.
// ---------------------------------------------------------------------------

interface FakeWorld {
  objects: Map<string, Uint8Array>;
  venueId: string;
  denyReview: boolean;
  denyAll: boolean;
}

const sql = postgres(process.env["DATABASE_URL"] ?? "", { max: 2 });

const FIXTURE_PREFIX = `photo-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const fixtureRowSchema = z.array(z.object({ id: z.string() }));

let fixtureBusinessId = "";
let fixtureVenueIds: Array<string> = [];
let fixtureVenueIndex = 0;

const takeVenueId = (): string => {
  const venueId = fixtureVenueIds[fixtureVenueIndex];

  fixtureVenueIndex += 1;

  if (venueId === undefined) {
    throw new Error("out of fixture venues for restaurant-photos tests");
  }

  return venueId;
};

beforeAll(async () => {
  const business = await sql`INSERT INTO feastjourney.restaurant_businesses (name)
    VALUES (${`${FIXTURE_PREFIX} business`}) RETURNING id::text AS id`;

  const businessId = fixtureRowSchema.parse(business)[0]?.id;

  if (businessId === undefined) {
    throw new Error("fixture business insert returned no id");
  }

  fixtureBusinessId = businessId;

  const venues: Array<string> = [];

  for (let n = 1; n <= 20; n += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Fixture setup runs once per file; sequential inserts keep ids deterministic.
    const inserted = await sql`INSERT INTO feastjourney.restaurant_venues
      (business_id, name, address, area, country_code, location)
      VALUES (${fixtureBusinessId}::uuid, ${`${FIXTURE_PREFIX} venue ${n}`},
        ${`${FIXTURE_PREFIX} address ${n}`}, ${`${FIXTURE_PREFIX} area`}, 'VN',
        ST_GeogFromText('SRID=4326;POINT(106.66 10.77)'))
      RETURNING id::text AS id`;

    const venueId = fixtureRowSchema.parse(inserted)[0]?.id;

    if (venueId === undefined) {
      throw new Error("fixture venue insert returned no id");
    }

    venues.push(venueId);
  }

  fixtureVenueIds = venues;
});

afterAll(async () => {
  await sql`DELETE FROM feastjourney.restaurant_venues WHERE business_id = ${fixtureBusinessId}::uuid`;
  await sql`DELETE FROM feastjourney.restaurant_businesses WHERE id = ${fixtureBusinessId}::uuid`;
  await sql.end();
});

const testLayers = (world: FakeWorld) => {
  const storage = Layer.succeed(RestaurantPhotoStorage, {
    putVariant: (key: string, bytes: Uint8Array) => {
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
      for (const key of keys) {
        world.objects.delete(key);
      }

      return Effect.void;
    },
  });

  const authorization = Layer.succeed(Authorization, {
    permissionsOf: () => Effect.succeed(new Set<Permission>()),
    has: () => Effect.succeed(true),
    require: (_actor: Actor, request: PermissionRequest) => {
      if (world.denyAll) {
        return Effect.fail(new InsufficientPermissions({ reason: "denied for test" }));
      }

      const actions: ReadonlyArray<string> = request.actions;

      if (world.denyReview && actions.includes("review")) {
        return Effect.fail(
          new InsufficientPermissions({ reason: "Missing permissions: restaurant:review." }),
        );
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

  return appRuntime.runPromise(
    Effect.provide(
      withActor(actor, effect),
      Layer.mergeAll(deps, Layer.provide(RestaurantPhotoServiceLive, deps)),
    ),
  );
};

const captureFailure = async <A, E>(
  world: FakeWorld,
  effect: Effect.Effect<A, E, ServiceEnv>,
  actor: Actor = Actor.Member({ userId: "test-member" }),
) => {
  const deps = testLayers(world);

  const exit = await appRuntime.runPromiseExit(
    Effect.provide(
      withActor(actor, effect),
      Layer.mergeAll(deps, Layer.provide(RestaurantPhotoServiceLive, deps)),
    ),
  );

  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }

  const failure = Cause.findErrorOption(exit.cause);

  if (Option.isNone(failure)) {
    throw new Error("expected a typed failure");
  }

  return failure.value;
};

const stageValidPhoto = async (
  world: FakeWorld,
  overrides?: Partial<{
    altText: string | null;
    attribution: string | null;
    license: string | null;
    makePrimary: boolean;
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

const publishValidPhoto = async (world: FakeWorld) => {
  const staged = await stageValidPhoto(world);

  const reviewed = await runService(
    world,
    Effect.flatMap(RestaurantPhotoService, (service) => service.submitForReview(staged.id)),
  );

  return runService(
    world,
    Effect.flatMap(RestaurantPhotoService, (service) => service.publishPhoto(reviewed.id)),
  );
};

describe("restaurant photo service rules", () => {
  test("stage, review, and publish a photo with same-origin delivery", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPhoto(world);

    expect(staged.status).toBe("draft");
    expect(staged.processing).toBe("ready");
    expect(staged.deliveryUrl).toBeNull();

    const reviewed = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.submitForReview(staged.id)),
    );

    expect(reviewed.status).toBe("review");

    const published = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.publishPhoto(reviewed.id)),
    );

    expect(published.status).toBe("published");
    expect(published.deliveryUrl).toBe(`/api/v1/restaurant-images/${published.id}/1/1600`);
    expect(published.srcSet).toContain(`/api/v1/restaurant-images/${published.id}/1/400 400w`);

    // Every stored byte lives under the photos prefix: scan (menu/) and
    // dish-media keys are different data classes and never appear here.
    expect(world.objects.size).toBe(3);

    for (const key of world.objects.keys()) {
      expect(key.startsWith("restaurant-photos/")).toBe(true);
      expect(key).not.toContain("menu/");
      expect(key).not.toContain("dish-media");
    }

    const served = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 1, width: 800, preview: false }),
      ),
    );

    expect(served.contentType).toBe("image/webp");
    expect(served.etag).toBe(`"rp-${published.id}-v1-800"`);
    expect(served.byteSize).toBeGreaterThan(0);
  });

  test("published photos group into client-safe PhotoRefs", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishValidPhoto(world);

    const grouped = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.publishedPhotosByVenueIds([published.venueId]),
      ),
      Actor.Guest(),
    );

    const refs = grouped.get(published.venueId);

    if (refs === undefined) {
      throw new Error("expected published photos for the venue");
    }

    expect(refs).toHaveLength(1);

    const ref = refs[0];

    if (ref === undefined) {
      throw new Error("expected one published photo for the venue");
    }

    expect(ref.assetId).toBe(published.id);
    expect(ref.primary).toBe(true);
    expect(ref.width).toBe(1200);
    expect(ref.height).toBe(800);
    expect(ref.variants).toHaveLength(3);

    for (const variant of ref.variants) {
      expect(variant.url.startsWith("/api/v1/restaurant-images/")).toBe(true);
      expect(variant.url).not.toContain("http");
    }
  });

  test("publish writes a mandatory audit row in the same transaction", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishValidPhoto(world);

    const rows = await sql`SELECT event, resource FROM feastjourney.security_audit_events
      WHERE event = 'restaurant.photo.published' AND resource = ${published.id}`;

    expect(rows.length).toBe(1);
  });

  test("drafts can never publish directly; review is mandatory", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPhoto(world);

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.publishPhoto(staged.id)),
    );

    expect(failure).toBeInstanceOf(RestaurantPhotoConflict);
  });

  test("publish without alt text, attribution, or real license is blocked", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPhoto(world, {
      altText: "   ",
      attribution: "   ",
      license: "unknown",
    });

    const reviewed = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.submitForReview(staged.id)),
    );

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.publishPhoto(reviewed.id)),
    );

    expect(failure).toBeInstanceOf(RestaurantPhotoPublishBlocked);

    if (failure instanceof RestaurantPhotoPublishBlocked) {
      expect(failure.reasons.join("; ")).toMatch(/license/);
      expect(failure.reasons.join("; ")).toMatch(/attribution/);
      expect(failure.reasons.join("; ")).toMatch(/alt text/);
    }

    // Blocked publication leaves the review state intact for correction.
    const queued = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.listReviewQueue(20)),
    );

    expect(queued.some((row) => row.id === staged.id)).toBe(true);
  });

  test("withdrawal revokes public delivery first; preview still serves", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishValidPhoto(world);

    const draft = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.returnToDraft(published.id)),
    );

    expect(draft.status).toBe("draft");
    expect(draft.deliveryUrl).toBeNull();

    // Public delivery 404s after withdrawal even with a valid version.
    const publicFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 1, width: 800, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(publicFailure).toBeInstanceOf(RestaurantPhotoNotFound);

    // Session-gated preview still serves the ready bytes for re-review.
    const previewed = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 1, width: 800, preview: true }),
      ),
    );

    expect(previewed.byteSize).toBeGreaterThan(0);

    // Guests never reach preview bytes.
    const guestFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 1, width: 800, preview: true }),
      ),
      Actor.Guest(),
    );

    expect(guestFailure).toBeInstanceOf(InsufficientPermissions);
  });

  test("removal deletes the row, revokes delivery, and cleans objects best-effort", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishValidPhoto(world);
    const keys = [...world.objects.keys()];

    expect(keys).toHaveLength(3);

    const removed = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.removePhoto(published.id)),
    );

    expect(removed.id).toBe(published.id);

    for (const key of keys) {
      expect(world.objects.has(key)).toBe(false);
    }

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 1, width: 800, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(failure).toBeInstanceOf(RestaurantPhotoNotFound);

    const rows = await sql`SELECT event FROM feastjourney.security_audit_events
      WHERE event = 'restaurant.photo.removed' AND resource = ${published.id}`;

    expect(rows.length).toBe(1);
  });

  test("removing a published photo needs the review grant", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: true,
      denyAll: false,
    };

    const published = await publishValidPhoto({ ...world, denyReview: false });

    const failure = await captureFailure(
      { ...world, objects: new Map() },
      Effect.flatMap(RestaurantPhotoService, (service) => service.removePhoto(published.id)),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);
  });

  test("reorder requires the exact photo set; primary follows sort order", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const first = await stageValidPhoto(world);
    const second = await stageValidPhoto(world, { makePrimary: false });

    const reordered = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.reorderPhotos({ venueId: world.venueId, orderedIds: [second.id, first.id] }),
      ),
    );

    expect(reordered.map((view) => view.id)).toEqual([second.id, first.id]);
    expect(reordered[0]?.isPrimary).toBe(true);

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.reorderPhotos({ venueId: world.venueId, orderedIds: [first.id] }),
      ),
    );

    expect(failure).toBeInstanceOf(RestaurantPhotoConflict);
  });

  test("makePrimary stages the photo first in sort order", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    await stageValidPhoto(world);
    const primary = await stageValidPhoto(world, { makePrimary: true });

    const views = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.listForAdmin(world.venueId)),
    );

    expect(views[0]?.id).toBe(primary.id);
  });

  test("the venue photo cap rejects a sixth photo", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    for (let index = 0; index < MAX_PHOTOS_PER_VENUE; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential staging keeps sort-order allocation deterministic per venue.
      await stageValidPhoto(world);
    }

    const extraBytes = await photoBytes(1200, 800);

    const failure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.stagePhoto({
          venueId: world.venueId,
          bytes: extraBytes,
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

    expect(failure).toBeInstanceOf(RestaurantPhotoLimitExceeded);
  });

  test("staging for an unknown venue reports not found", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: crypto.randomUUID(),
      denyReview: false,
      denyAll: false,
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

    expect(failure).toBeInstanceOf(RestaurantNotFound);
  });

  test("guests cannot stage photos", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
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
      Actor.Guest(),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);
  });

  test("metadata validation rejects bad focal points and non-https sources", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPhoto(world);

    const focalFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.updateMetadata({
          photoId: staged.id,
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: 2,
          focalY: null,
          sourceUrl: null,
        }),
      ),
    );

    expect(focalFailure).toBeInstanceOf(RestaurantPhotoValidationFailed);

    const sourceFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.updateMetadata({
          photoId: staged.id,
          altText: "Alt",
          attribution: "Test",
          license: "own-work",
          focalX: null,
          focalY: null,
          sourceUrl: "http://example.com/photo.jpg",
        }),
      ),
    );

    expect(sourceFailure).toBeInstanceOf(RestaurantPhotoValidationFailed);
  });

  test("serveDerivative rejects unknown widths and stale versions", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishValidPhoto(world);

    const widthFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 1, width: 200, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(widthFailure).toBeInstanceOf(RestaurantPhotoValidationFailed);

    const versionFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: published.id, version: 2, width: 800, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(versionFailure).toBeInstanceOf(RestaurantPhotoNotFound);
  });

  test("drafts and review items never serve publicly", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPhoto(world);

    const draftFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: staged.id, version: 1, width: 800, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(draftFailure).toBeInstanceOf(RestaurantPhotoNotFound);

    const reviewed = await runService(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) => service.submitForReview(staged.id)),
    );

    const reviewFailure = await captureFailure(
      world,
      Effect.flatMap(RestaurantPhotoService, (service) =>
        service.serveDerivative({ photoId: reviewed.id, version: 1, width: 800, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(reviewFailure).toBeInstanceOf(RestaurantPhotoNotFound);
  });
});

describe("restaurant photo storage adapter (disposable)", () => {
  test("PUT/HEAD/GET/DELETE round-trip against a real Garage", async () => {
    const endpoint = process.env["S3_ENDPOINT_INTERNAL"];
    const accessKeyId = process.env["S3_ACCESS_KEY_ID"];
    const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY"];

    if (endpoint === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
      console.log("skip: no S3 env (CI garage job provides disposable credentials)");

      return;
    }

    const prefix = `photo-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `${prefix}/400.webp`;

    const payload = new Uint8Array(
      await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 40, g: 120, b: 180 } },
      })
        .webp()
        .toBuffer(),
    );

    await appRuntime.runPromise(
      Effect.provide(
        Effect.flatMap(RestaurantPhotoStorage, (storage) =>
          Effect.gen(function* () {
            yield* storage.putVariant(key, payload);
            const exists = yield* storage.variantExists(key);
            expect(exists).toBe(true);
            const bytes = yield* storage.getVariant(key);
            expect(bytes.byteLength).toBe(payload.byteLength);
            yield* storage.deleteVariants([key]);
            const gone = yield* storage.variantExists(key);
            expect(gone).toBe(false);
          }),
        ),
        RestaurantPhotoStorageLive,
      ),
    );
  });
});
