import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Layer, Option } from "effect";
import postgres from "postgres";
import sharp from "sharp";
import { z } from "zod";

import {
  RestaurantPhotoStorage,
  RestaurantPhotoStorageFailed,
} from "@/modules/restaurant-discovery/server/integrations/restaurant-photo-storage";
import {
  MAX_MENU_PAGES_PER_VENUE,
  MenuPageConflict,
  MenuPageLimitExceeded,
  MenuPageNotFound,
  MenuPagePublishBlocked,
  MenuPageRepositoryLive,
  MenuPageService,
  MenuPageServiceLive,
  MenuPageValidationFailed,
  validateMenuPageImage,
} from "@/modules/restaurant-discovery/server/operations/menu-page-media";
import type { MenuPageRepository } from "@/modules/restaurant-discovery/server/operations/menu-page-media";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { withActor, type CurrentActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { Permission, PermissionRequest } from "@/server/auth/permissions";
import type { Database } from "@/server/database/client";
import { appRuntime } from "@/server/runtime";

// oxlint-disable-next-line import/no-unassigned-import -- seeds disposable-DB env guard at import time; this file owns no fixtures.
import "./cleanup";

/**
 * Menu-page media: validation plus stage/submit/publish/withdraw/remove
 * rules. The suite runs the real MenuPageService against the real
 * repository and disposable database with an in-memory object store and a
 * stubbed Authorization. Stored bytes never touch Garage or production
 * buckets; only the shared private-bucket adapter interface is exercised.
 *
 * Data-class isolation: menu-page rows must never reference private
 * menu-scan assets (menu_scan_assets, menu/ keys). Every stored key carries
 * the menu-pages/ prefix enforced by the table CHECK, and the suite asserts
 * that scan-style keys are rejected and unresolvable.
 */

const pageBytes = async (
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" = "jpeg",
): Promise<Uint8Array> => {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 250, g: 245, b: 235 } },
  });

  if (format === "jpeg") {
    return new Uint8Array(await base.jpeg().toBuffer());
  }

  if (format === "png") {
    return new Uint8Array(await base.png().toBuffer());
  }

  return new Uint8Array(await base.webp().toBuffer());
};

const validationReason = async (task: Promise<unknown>): Promise<string> => {
  try {
    await task;
  } catch (error) {
    if (error instanceof MenuPageValidationFailed) {
      return error.reason;
    }

    throw error;
  }

  throw new Error("expected a validation failure");
};

interface FakeWorld {
  objects: Map<string, Uint8Array>;
  venueId: string;
  denyReview: boolean;
  denyAll: boolean;
}

const sql = postgres(process.env["DATABASE_URL"] ?? "", { max: 2 });

const FIXTURE_PREFIX = `menupage-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let fixtureBusinessId = "";
let fixtureVenueIds: Array<string> = [];
let fixtureVenueIndex = 0;
const fixtureMenuByVenue = new Map<string, string>();

const takeVenueId = (): string => {
  const venueId = fixtureVenueIds[fixtureVenueIndex];

  fixtureVenueIndex += 1;

  if (venueId === undefined) {
    throw new Error("out of fixture venues for menu-pages tests");
  }

  return venueId;
};

beforeAll(async () => {
  const business = await sql`INSERT INTO feastjourney.restaurant_businesses (name)
    VALUES (${`${FIXTURE_PREFIX} business`}) RETURNING id::text AS id`;

  const businessId = z.array(z.object({ id: z.string() })).parse(business)[0]?.id;

  if (businessId === undefined) {
    throw new Error("fixture business insert returned no id");
  }

  fixtureBusinessId = businessId;

  const venues: Array<string> = [];

  for (let n = 1; n <= 20; n += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Fixture setup runs once per file; sequential inserts keep ids deterministic.
    const inserted = await sql`INSERT INTO feastjourney.restaurant_venues
      (business_id, name, address, area, country_code, location)
      VALUES (${fixtureBusinessId}::uuid, ${`${FIXTURE_PREFIX} venue ${n}`},
        ${`${FIXTURE_PREFIX} address ${n}`}, ${`${FIXTURE_PREFIX} area`}, 'VN',
        ST_GeogFromText('SRID=4326;POINT(106.66 10.77)'))
      RETURNING id::text AS id`;

    const venueId = z.array(z.object({ id: z.string() })).parse(inserted)[0]?.id;

    if (venueId === undefined) {
      throw new Error("fixture venue insert returned no id");
    }

    venues.push(venueId);

    // oxlint-disable-next-line no-await-in-loop -- Fixture setup runs once per file.
    const menu = await sql`INSERT INTO feastjourney.restaurant_menus (venue_id, name)
      VALUES (${venueId}::uuid, ${`${FIXTURE_PREFIX} menu ${n}`})
      RETURNING id::text AS id`;

    const menuId = z.array(z.object({ id: z.string() })).parse(menu)[0]?.id;

    if (menuId === undefined) {
      throw new Error("fixture menu insert returned no id");
    }

    fixtureMenuByVenue.set(venueId, menuId);
  }

  fixtureVenueIds = venues;
});

afterAll(async () => {
  await sql`DELETE FROM feastjourney.restaurant_menu_pages WHERE venue_id = ANY(${fixtureVenueIds}::uuid[])`;
  await sql`DELETE FROM feastjourney.restaurant_menus WHERE venue_id = ANY(${fixtureVenueIds}::uuid[])`;
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
    require: (actor: Actor, request: PermissionRequest) => {
      if (Actor.$match(actor, { Guest: () => true, Member: () => false })) {
        return Effect.fail(new InsufficientPermissions({ reason: "guests hold no grants" }));
      }

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

  return Layer.mergeAll(MenuPageRepositoryLive, storage, authorization);
};

type ServiceEnv =
  | MenuPageService
  | MenuPageRepository
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
      Layer.mergeAll(deps, Layer.provide(MenuPageServiceLive, deps)),
    ),
  );
};

const captureFailure = async <A, E>(
  world: FakeWorld,
  effect: Effect.Effect<A, E, ServiceEnv>,
  actor: Actor = Actor.Member({ userId: "test-member" }),
): Promise<E> => {
  const deps = testLayers(world);

  const exit = await appRuntime.runPromiseExit(
    Effect.provide(
      withActor(actor, effect),
      Layer.mergeAll(deps, Layer.provide(MenuPageServiceLive, deps)),
    ),
  );

  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure");
  }

  const failure = Cause.findErrorOption(exit.cause);

  if (Option.isNone(failure)) {
    throw new Error("expected a typed failure");
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: test helper returns the asserted failure for typed assertions; tsc-clean under live-DB Reylo
  return failure.value as E;
};

const stageValidPage = async (
  world: FakeWorld,
  overrides?: Partial<{
    attribution: string | null;
    license: string;
    menuId: string | null;
  }>,
) => {
  const menuId = overrides?.menuId !== undefined ? overrides.menuId : null;
  const bytes = await pageBytes(1200, 900);

  return runService(
    world,
    Effect.flatMap(MenuPageService, (service) =>
      service.stagePage({
        venueId: world.venueId,
        menuId,
        bytes,
        filename: "menu-page-1.jpg",
        sourceUrl: null,
        sourceName: "House menu",
        rightsHolder: null,
        license: overrides?.license ?? "unknown",
        licenseEvidence: null,
        attribution: overrides?.attribution ?? null,
        observedAt: "2026-10-01",
      }),
    ),
  );
};

const publishablePage = async (world: FakeWorld) => {
  const staged = await stageValidPage(world, {
    attribution: "Test venue",
    license: "own-work",
  });

  const reviewed = await runService(
    world,
    Effect.flatMap(MenuPageService, (service) => service.submitForReview(staged.id)),
  );

  return runService(
    world,
    Effect.flatMap(MenuPageService, (service) => service.publishPage(reviewed.id)),
  );
};

describe("menu page validation", () => {
  test("accepts a readable JPEG page", async () => {
    const validated = await validateMenuPageImage(await pageBytes(1200, 900), "page.jpg");

    expect(validated.format).toBe("jpeg");
    expect(validated.width).toBe(1200);
    expect(validated.height).toBe(900);
    expect(validated.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("accepts PNG sources", async () => {
    const validated = await validateMenuPageImage(await pageBytes(900, 1200, "png"), "page.png");

    expect(validated.format).toBe("png");
  });

  test("rejects non-image uploads", async () => {
    expect(await validationReason(validateMenuPageImage(new Uint8Array(0), "page.jpg"))).toMatch(
      /empty file/,
    );

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 59]);

    expect(await validationReason(validateMenuPageImage(gif, "page.gif"))).toMatch(/not accepted/);
  });

  test("rejects images whose shortest side is under 600px", async () => {
    expect(
      await validationReason(validateMenuPageImage(await pageBytes(1200, 400), "wide.jpg")),
    ).toMatch(/shortest side/);
  });
});

describe("menu page lifecycle", () => {
  test("guests cannot stage pages", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const failure = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.stagePage({
          venueId: world.venueId,
          menuId: null,
          bytes: new Uint8Array([1, 2, 3]),
          filename: "page.jpg",
          sourceUrl: null,
          sourceName: null,
          rightsHolder: null,
          license: "unknown",
          licenseEvidence: null,
          attribution: null,
          observedAt: null,
        }),
      ),
      Actor.Guest(),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);
  });

  test("members without restaurant:manage cannot stage pages", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: true,
    };

    const failure = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.stagePage({
          venueId: world.venueId,
          menuId: null,
          bytes: new Uint8Array([1, 2, 3]),
          filename: "page.jpg",
          sourceUrl: null,
          sourceName: null,
          rightsHolder: null,
          license: "unknown",
          licenseEvidence: null,
          attribution: null,
          observedAt: null,
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);
  });

  test("stage stores bytes under the menu-pages prefix and stays draft", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPage(world);

    expect(staged.status).toBe("draft");
    expect(staged.deliveryUrl).toBeNull();
    expect(staged.previewUrl).toBe(`/api/v1/menu-pages/${staged.id}?preview=1`);

    expect(world.objects.size).toBe(1);

    for (const key of world.objects.keys()) {
      expect(key.startsWith(`menu-pages/${world.venueId}/${staged.id}/`)).toBe(true);
      expect(key).not.toContain("menu/scan");
      expect(key).not.toContain("dish-media");
      expect(key).not.toContain("restaurant-photos");
    }

    // Public reads stay empty until publication.
    const publicBefore = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.listPublishedByVenue(world.venueId)),
      Actor.Guest(),
    );

    expect(publicBefore).toEqual([]);
  });

  test("scan-style object keys are rejected by the table CHECK", async () => {
    const venueId = takeVenueId();

    let rejected: Error | null = null;

    try {
      await sql`INSERT INTO feastjourney.restaurant_menu_pages
        (venue_id, page_order, object_key, license, original_width, original_height, format, byte_size, checksum_sha256, uploaded_by)
        VALUES (${venueId}::uuid, 0, 'menu/scan-asset-key', 'unknown', 1200, 900, 'jpeg', 10, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'test')`;
    } catch (error) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }

    expect(rejected).not.toBeNull();
  });

  test("unknown page ids never resolve to bytes", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const failure = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.servePage({ pageId: crypto.randomUUID(), preview: false }),
      ),
      Actor.Guest(),
    );

    expect(failure).toBeInstanceOf(MenuPageNotFound);
  });

  test("license-gated publish: unknown license and missing attribution block", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const staged = await stageValidPage(world);

    const reviewed = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.submitForReview(staged.id)),
    );

    expect(reviewed.status).toBe("review");

    const blocked = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) => service.publishPage(reviewed.id)),
    );

    expect(blocked).toBeInstanceOf(MenuPagePublishBlocked);

    if (!(blocked instanceof MenuPagePublishBlocked)) {
      throw new Error("expected a publish-blocked failure");
    }

    const reasons = blocked.reasons.join("; ");

    expect(reasons).toMatch(/license/);
    expect(reasons).toMatch(/attribution/);

    const repaired = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.updateMetadata({
          pageId: reviewed.id,
          menuId: null,
          sourceUrl: null,
          sourceName: "House menu",
          rightsHolder: null,
          license: "own-work",
          licenseEvidence: null,
          attribution: "Test venue",
          observedAt: "2026-10-01",
        }),
      ),
    );

    expect(repaired.license).toBe("own-work");

    const published = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.publishPage(repaired.id)),
    );

    expect(published.status).toBe("published");
    expect(published.deliveryUrl).toBe(`/api/v1/menu-pages/${published.id}`);

    const served = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.servePage({ pageId: published.id, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(served.contentType).toBe("image/jpeg");
    expect(served.byteSize).toBeGreaterThan(0);
  });

  test("publishing without the review grant is denied", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: true,
      denyAll: false,
    };

    const staged = await stageValidPage(world, {
      attribution: "Test venue",
      license: "cc-by",
    });

    const reviewed = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.submitForReview(staged.id)),
    );

    const failure = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) => service.publishPage(reviewed.id)),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);
  });

  test("order is preserved across reorder and public reads", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const first = await publishablePage(world);
    const second = await publishablePage(world);
    const third = await publishablePage(world);

    const reordered = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.reorderPages({
          venueId: world.venueId,
          orderedIds: [third.id, first.id, second.id],
        }),
      ),
    );

    expect(reordered.map((view) => view.id)).toEqual([third.id, first.id, second.id]);

    const publicAfter = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.listPublishedByVenue(world.venueId)),
      Actor.Guest(),
    );

    expect(publicAfter.map((view) => view.id)).toEqual([third.id, first.id, second.id]);

    for (const view of publicAfter) {
      expect(view.deliveryUrl).toBe(`/api/v1/menu-pages/${view.id}`);
      expect(view.attribution).toBe("Test venue");
    }
  });

  test("venue scoping: pages never leak across venues", async () => {
    const worldA: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const otherVenueId = takeVenueId();

    const published = await publishablePage(worldA);

    const foreign = await runService(
      worldA,
      Effect.flatMap(MenuPageService, (service) => service.listPublishedByVenue(otherVenueId)),
      Actor.Guest(),
    );

    expect(foreign).toEqual([]);

    // Cross-venue ids cannot enter another venue's order.
    const conflict = await captureFailure(
      worldA,
      Effect.flatMap(MenuPageService, (service) =>
        service.reorderPages({ venueId: otherVenueId, orderedIds: [published.id] }),
      ),
    );

    expect(conflict).toBeInstanceOf(MenuPageConflict);
  });

  test("menu links must belong to the page venue", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const ownMenuId = fixtureMenuByVenue.get(world.venueId);

    if (ownMenuId === undefined) {
      throw new Error("expected a fixture menu for the venue");
    }

    const otherVenueId = takeVenueId();
    const foreignMenuId = fixtureMenuByVenue.get(otherVenueId);

    if (foreignMenuId === undefined) {
      throw new Error("expected a fixture menu for the other venue");
    }

    const linked = await stageValidPage(world, { menuId: ownMenuId });

    expect(linked.menuId).toBe(ownMenuId);

    const foreignBytes = await pageBytes(1200, 900);

    const failure = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.stagePage({
          venueId: world.venueId,
          menuId: foreignMenuId,
          bytes: foreignBytes,
          filename: "menu-page-foreign.jpg",
          sourceUrl: null,
          sourceName: null,
          rightsHolder: null,
          license: "unknown",
          licenseEvidence: null,
          attribution: null,
          observedAt: null,
        }),
      ),
    );

    expect(failure).toBeInstanceOf(MenuPageConflict);
  });

  test("withdrawal revokes public delivery but keeps staff preview", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishablePage(world);

    const withdrawn = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.withdrawPage(published.id)),
    );

    expect(withdrawn.status).toBe("draft");
    expect(withdrawn.deliveryUrl).toBeNull();

    const publicAfter = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.listPublishedByVenue(world.venueId)),
      Actor.Guest(),
    );

    expect(publicAfter).toEqual([]);

    const revoked = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.servePage({ pageId: published.id, preview: false }),
      ),
      Actor.Guest(),
    );

    expect(revoked).toBeInstanceOf(MenuPageNotFound);

    const preview = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.servePage({ pageId: published.id, preview: true }),
      ),
    );

    expect(preview.byteSize).toBeGreaterThan(0);
  });

  test("remove ends in the terminal state and deletes stored bytes", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    const published = await publishablePage(world);

    const removed = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.removePage(published.id)),
    );

    expect(removed.id).toBe(published.id);
    expect(removed.venueId).toBe(world.venueId);
    expect(world.objects.size).toBe(0);

    const publicAfter = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.listPublishedByVenue(world.venueId)),
      Actor.Guest(),
    );

    expect(publicAfter).toEqual([]);

    const gone = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.servePage({ pageId: published.id, preview: true }),
      ),
    );

    expect(gone).toBeInstanceOf(MenuPageNotFound);

    const adminAfter = await runService(
      world,
      Effect.flatMap(MenuPageService, (service) => service.listForAdmin(world.venueId)),
    );

    expect(adminAfter.map((view) => view.id)).not.toContain(published.id);
  });

  test("venue page cap rejects the thirteenth live page", async () => {
    const world: FakeWorld = {
      objects: new Map(),
      venueId: takeVenueId(),
      denyReview: false,
      denyAll: false,
    };

    for (let n = 0; n < MAX_MENU_PAGES_PER_VENUE; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential staging keeps page_order deterministic.
      await stageValidPage(world);
    }

    const extraBytes = await pageBytes(1200, 900);

    const failure = await captureFailure(
      world,
      Effect.flatMap(MenuPageService, (service) =>
        service.stagePage({
          venueId: world.venueId,
          menuId: null,
          bytes: extraBytes,
          filename: "menu-page-extra.jpg",
          sourceUrl: null,
          sourceName: null,
          rightsHolder: null,
          license: "unknown",
          licenseEvidence: null,
          attribution: null,
          observedAt: null,
        }),
      ),
    );

    expect(failure).toBeInstanceOf(MenuPageLimitExceeded);
  });
});
