import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import { CurationService } from "@/modules/food-discovery/server/operations/curation-service";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createdSlugs } from "./cleanup";

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

const expectFailure = async <A, E, R extends AppServices>(
  effect: Effect.Effect<A, E, R>,
  expectedTag: string,
): Promise<void> => {
  try {
    await run(effect);
  } catch (error) {
    expect(error).toMatchObject({ _tag: expectedTag });

    return;
  }

  throw new Error(`expected ${expectedTag} but the effect succeeded`);
};

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const slugFor = (name: string): string => `upd-places-${name}-${stamp}`;

const ACTOR = "admin:test-dish-update";

const createDish = (slug: string): Promise<{ readonly id: string; readonly slug: string }> => {
  createdSlugs.push(slug);

  return run(
    Effect.flatMap(AdminService, (service) =>
      service.createDish(ACTOR, {
        slug,
        status: "draft",
        names: [{ languageTag: "en", name: `Dish ${slug}`, nameKind: "localized" }],
      }),
    ),
  );
};

describe("resolvePlaceRefLocal", () => {
  test("resolves registry id, ISO code, and scoped city name", async () => {
    const byIso = await run(
      Effect.flatMap(AdminService, (service) => service.resolvePlaceRefLocal({ iso: "VN" })),
    );

    expect(byIso).toBeGreaterThan(0n);

    const byId = await run(
      Effect.flatMap(AdminService, (service) =>
        service.resolvePlaceRefLocal({ placeId: byIso.toString() }),
      ),
    );

    expect(byId).toBe(byIso);

    const hanoi = await run(
      Effect.flatMap(AdminService, (service) =>
        service.resolvePlaceRefLocal({ city: "Hanoi", parentIso: "VN" }),
      ),
    );

    // A city resolves to a sub-country registry entry, never the country
    // itself, and the resolved entry links like any other place ref.
    expect(hanoi).not.toBe(byIso);

    const dish = await createDish(slugFor("citylink"));

    const linked = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [{ place: { city: "Hanoi", parentIso: "VN" } }],
          removePlaceIds: [],
        }),
      ),
    );

    expect(linked.places).toHaveLength(1);
    expect(linked.places[0]?.placeId).toBe(hanoi.toString());
  });

  test("rejects unknown and mismatched place references", async () => {
    await expectFailure(
      Effect.flatMap(AdminService, (service) => service.resolvePlaceRefLocal({ iso: "XX" })),
      "InvalidSearchFilter",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.resolvePlaceRefLocal({ city: "No Such City Anywhere" }),
      ),
      "InvalidSearchFilter",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.resolvePlaceRefLocal({ city: "Hanoi", parentIso: "JP" }),
      ),
      "InvalidSearchFilter",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.resolvePlaceRefLocal({ placeId: "999999999" }),
      ),
      "InvalidSearchFilter",
    );
  });
});

describe("dish place updates", () => {
  test("changing association updates the link in place without duplicates", async () => {
    const dish = await createDish(slugFor("assoc"));

    const initial = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [{ place: { iso: "VN" } }],
          removePlaceIds: [],
        }),
      ),
    );

    expect(initial.upserted).toBe(1);
    expect(initial.places).toHaveLength(1);
    // Linking defaults to `associated`, never `origin`.
    expect(initial.places[0]?.association).toBe("associated");
    expect(initial.places[0]?.isDisputed).toBe(false);

    const changed = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [
            { place: { iso: "VN" }, association: "popular", isDisputed: true, note: "Loved here." },
          ],
          removePlaceIds: [],
        }),
      ),
    );

    expect(changed.upserted).toBe(1);
    expect(changed.removed).toBe(0);
    expect(changed.places).toHaveLength(1);
    expect(changed.places[0]?.placeId).toBe(initial.places[0]?.placeId);
    expect(changed.places[0]?.association).toBe("popular");
    expect(changed.places[0]?.isDisputed).toBe(true);
    expect(changed.places[0]?.note).toBe("Loved here.");

    const revisions = await run(
      Effect.flatMap(CurationService, (curation) => curation.listRevisions(dish.id, 10)),
    );

    expect(revisions.some((entry) => entry.operation === "place_linked")).toBe(true);
  });

  test("link removal preserves sibling links", async () => {
    const dish = await createDish(slugFor("siblings"));

    const vietnam = await run(
      Effect.flatMap(AdminService, (service) => service.resolvePlaceRefLocal({ iso: "VN" })),
    );

    const japan = await run(
      Effect.flatMap(AdminService, (service) => service.resolvePlaceRefLocal({ iso: "JP" })),
    );

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [{ place: { iso: "VN" } }, { place: { iso: "JP" }, association: "popular" }],
          removePlaceIds: [],
        }),
      ),
    );

    const removed = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [],
          removePlaceIds: [vietnam.toString()],
        }),
      ),
    );

    expect(removed.removed).toBe(1);
    expect(removed.places).toHaveLength(1);
    expect(removed.places[0]?.placeId).toBe(japan.toString());
    expect(removed.places[0]?.association).toBe("popular");
  });

  test("rejects duplicate links and unknown removals", async () => {
    const dish = await createDish(slugFor("dupes"));

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [{ place: { iso: "VN" } }, { place: { iso: "vn" } }],
          removePlaceIds: [],
        }),
      ),
      "InvalidDishData",
    );

    const vietnam = await run(
      Effect.flatMap(AdminService, (service) => service.resolvePlaceRefLocal({ iso: "VN" })),
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [{ place: { iso: "VN" } }],
          removePlaceIds: [vietnam.toString()],
        }),
      ),
      "InvalidDishData",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishPlaces(ACTOR, dish.id, {
          upsert: [],
          removePlaceIds: [vietnam.toString()],
        }),
      ),
      "InvalidDishData",
    );
  });
});

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBeTruthy();
});

afterAll(async () => {
  if (createdSlugs.length === 0) {
    return;
  }

  const { Database } = await import("@/server/database/client");

  await appRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;

      for (const slug of createdSlugs) {
        if (!slug.startsWith("upd-places-")) {
          continue;
        }

        yield* Effect.tryPromise({
          try: () => db.sql`DELETE FROM feastjourney.dishes WHERE slug = ${slug}`,
          catch: () => new Error("cleanup failed"),
        });
      }
    }),
  );
});
