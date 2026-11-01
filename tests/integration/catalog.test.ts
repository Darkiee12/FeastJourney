import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import { CatalogService } from "@/modules/food-discovery/server/operations/catalog-service";
import { CurationService } from "@/modules/food-discovery/server/operations/curation-service";
import { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import { DishRepository } from "@/modules/food-discovery/server/repository/dish-repository";
import { withTransaction, Database } from "@/server/database/client";
import { runQuery } from "@/server/database/query";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createdSlugs } from "./cleanup";

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

describe("catalog search", () => {
  test("finds Pho by ASCII query via diacritic-folded search keys", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ q: "pho", locale: "en", limit: 20 }),
      ),
    );

    const names = output.items.map((item) => item.englishName);

    expect(names).toContain("Pho");
    expect(names).toContain("Pho bo");
    expect(output.nextCursor).toBeNull();
  });

  test("finds Banh mi by ASCII query and resolves native names", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ q: "banh mi", locale: "vi", limit: 20 }),
      ),
    );

    expect(output.items.length).toBeGreaterThan(0);
    expect(output.items[0]?.name).toBe("Bánh mì");
  });

  test("matches native-script queries without transliteration", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ q: "寿司", locale: "ja", limit: 20 }),
      ),
    );

    expect(output.items.length).toBeGreaterThan(0);
    expect(output.items[0]?.englishName).toBe("Sushi");
  });

  test("paginates with a stable keyset cursor", async () => {
    const first = await run(
      Effect.flatMap(DishService, (service) => service.searchDishes({ locale: "en", limit: 5 })),
    );

    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();

    const second = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({
          locale: "en",
          limit: 5,
          cursor: first.nextCursor ?? undefined,
        }),
      ),
    );

    const firstIds = new Set(first.items.map((item) => item.id));

    expect(second.items.length).toBeGreaterThan(0);

    for (const item of second.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });

  test("rejects invalid locales at the service boundary", async () => {
    const exit = await appRuntime.runPromiseExit(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ locale: "xx-invalid!", limit: 20 }),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });
});

describe("dish detail", () => {
  test("resolves by slug and links the parent variant", async () => {
    const detail = await run(
      Effect.flatMap(DishService, (service) => service.getDish("pho-bo", "en")),
    );

    expect(detail.slug).toBe("pho-bo");
    expect(detail.englishName).toBe("Pho bo");
    expect(detail.parent?.slug).toBe("pho");
    expect(detail.places.length).toBeGreaterThan(0);
    expect(Number.isInteger(detail.lastUpdate)).toBe(true);
    expect(detail.sources.length).toBeGreaterThanOrEqual(0);
  });

  test("resolves by numeric id as well", async () => {
    const bySlug = await run(
      Effect.flatMap(DishService, (service) => service.getDish("sushi", "en")),
    );

    const byId = await run(
      Effect.flatMap(DishService, (service) => service.getDish(bySlug.id, "en")),
    );

    expect(byId.slug).toBe("sushi");
  });

  test("returns related dishes through shared relations", async () => {
    const related = await run(
      Effect.flatMap(DishService, (service) => service.getRelated("pho", "en", 8)),
    );

    const slugs = related.map((item) => item.slug);

    expect(slugs).toContain("pho-bo");
    expect(slugs).not.toContain("pho");
  });
});

describe("ingredient filtering", () => {
  test("requires every ingredient in all mode", async () => {
    const egg = await run(
      Effect.flatMap(CatalogService, (service) => service.searchIngredients("egg", "en", 5)),
    );

    const rice = await run(
      Effect.flatMap(CatalogService, (service) => service.searchIngredients("rice", "en", 5)),
    );

    const eggId = egg[0]?.id;
    const riceId = rice.find((entry) => entry.displayName === "rice")?.id;

    expect(eggId).toBeDefined();
    expect(riceId).toBeDefined();

    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({
          locale: "en",
          ingredientIds: [eggId ?? "", riceId ?? ""],
          ingredientMode: "all",
          limit: 50,
        }),
      ),
    );

    const slugs = output.items.map((item) => item.slug);

    expect(slugs).toContain("bibimbap");
    expect(slugs).not.toContain("sushi");
  });
});

describe("geography", () => {
  test("resolves countries by ISO code and expands descendants", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ locale: "en", country: "VN", limit: 50 }),
      ),
    );

    const slugs = output.items.map((item) => item.slug);

    expect(slugs).toContain("pho");
    expect(slugs).toContain("pho-bo");
  });

  test("keeps origin and popularity distinct", async () => {
    const detail = await run(
      Effect.flatMap(DishService, (service) => service.getDish("paella", "en")),
    );

    const associations = new Set(detail.places.map((place) => place.association));

    expect(associations.has("origin")).toBe(true);
    expect(associations.has("popular")).toBe(true);
  });
});

describe("nearest city", () => {
  test("resolves Hanoi from nearby coordinates with context and country", async () => {
    const city = await run(
      Effect.flatMap(CatalogService, (service) => service.nearestCity(21.0285, 105.8542, "en")),
    );

    expect(city).not.toBeNull();
    expect(city?.name).toMatch(/Hà Nội|Hanoi/);
    expect(city?.country).toBe("VN");
  });

  test("returns null mid-ocean where no city is close enough", async () => {
    const city = await run(
      Effect.flatMap(CatalogService, (service) => service.nearestCity(0, -140, "en")),
    );

    expect(city).toBeNull();
  });

  test("returns null for non-finite coordinates without querying", async () => {
    const city = await run(
      Effect.flatMap(CatalogService, (service) => service.nearestCity(Number.NaN, 105.8542, "en")),
    );

    expect(city).toBeNull();
  });
});

describe("publication validation", () => {
  test("published dishes satisfy the catalog policy", async () => {
    const pho = await run(Effect.flatMap(DishService, (service) => service.getDish("pho", "en")));

    const check = await run(
      Effect.flatMap(CurationService, (service) => service.validatePublication(BigInt(pho.id))),
    );

    expect(check.publishable).toBe(true);
    expect(check.reasons).toHaveLength(0);
  });

  test("incomplete review drafts fail validation with reasons", async () => {
    const slug = `test-validate-${Date.now().toString(36)}`;
    createdSlugs.push(slug);

    const created = await run(
      Effect.flatMap(AdminService, (service) =>
        service.createDish("test", {
          slug,
          status: "draft",
          names: [{ languageTag: "vi", name: "Món Thử", nameKind: "native" }],
        }),
      ),
    );

    const check = await run(
      Effect.flatMap(CurationService, (service) => service.validatePublication(BigInt(created.id))),
    );

    expect(check.publishable).toBe(false);
    expect(check.reasons).toContain("published dishes require a preferred English name");
    expect(check.reasons).toContain("published dishes require a description or summary");
    expect(check.reasons).toContain("published dishes require at least one category");
  });
});

describe("transactions", () => {
  test("rolls back partial writes on failure", async () => {
    const slug = `test-rollback-${Date.now().toString(36)}`;

    await appRuntime
      .runPromise(
        withTransaction(
          "test/rollback",
          Effect.gen(function* () {
            const dishes = yield* DishRepository;

            yield* dishes.insert({ slug, parentDishId: null, status: "draft" });

            return yield* Effect.fail(new Error("boom"));
          }),
        ),
      )
      .catch(() => undefined);

    const found = await run(
      Effect.flatMap(DishRepository, (repository) => repository.findBySlug(slug)),
    );

    expect(found).toBeNull();
  });

  test("rejects place hierarchy cycles at the database boundary", async () => {
    const failure = await run(
      Effect.flip(
        runQuery(
          "test/cycle",
          (sql) =>
            sql`INSERT INTO feastjourney.place_parents (place_id, parent_place_id)
            SELECT child.id, parent.id
            FROM feastjourney.places AS child, feastjourney.places AS parent
            WHERE child.iso3166 = 'VN' AND parent.iso3166 = 'VN'`,
        ),
      ),
    );

    expect(failure._tag).toBe("PersistenceError");
  });
});

afterAll(async () => {
  if (createdSlugs.length === 0) {
    return;
  }

  await appRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;

      for (const slug of createdSlugs) {
        yield* Effect.tryPromise({
          try: () => db.sql`DELETE FROM feastjourney.dishes WHERE slug = ${slug}`,
          catch: () => new Error("cleanup failed"),
        });
      }
    }),
  );
});

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBeDefined();
});
