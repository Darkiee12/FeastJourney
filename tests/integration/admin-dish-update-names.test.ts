import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import { CurationService } from "@/modules/food-discovery/server/operations/curation-service";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
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

const slugFor = (name: string): string => `upd-names-${name}-${stamp}`;

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

/**
 * Seed ingredient handle for link tests. The seed catalog owns the
 * ingredient row; the test only creates and deletes its own dish links, so
 * there is nothing to clean up. Resolution returns plain domain data, never
 * raw SQL rows.
 */
const seedIngredientId = async (searchKey: string): Promise<string> => {
  const matches = await run(
    Effect.flatMap(IngredientRepository, (repository) =>
      repository.resolveByKey(searchKey, "en", 5),
    ),
  );

  const first = matches[0];

  if (first === undefined) {
    throw new Error(`seed ingredient "${searchKey}" is missing`);
  }

  return first.ingredientId.toString();
};

describe("dish field updates", () => {
  test("updates slug in place and clears the parent with explicit null", async () => {
    const parent = await createDish(slugFor("parent"));
    const child = await createDish(slugFor("child"));

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDish(ACTOR, child.id, { parentSlug: parent.slug }),
      ),
    );

    const renamed = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishFields(ACTOR, child.id, {
          slug: slugFor("renamed"),
          parentSlug: null,
        }),
      ),
    );

    expect(renamed.id).toBe(child.id);
    expect(renamed.slug).toBe(slugFor("renamed"));
    expect(renamed.parentDishId).toBeNull();
  });

  test("rejects self-parenting and parent cycles", async () => {
    const dish = await createDish(slugFor("selfparent"));

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishFields(ACTOR, dish.id, { parentSlug: dish.slug }),
      ),
      "InvalidDishData",
    );

    const grandchild = await createDish(slugFor("grandchild"));

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDish(ACTOR, grandchild.id, { parentSlug: dish.slug }),
      ),
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishFields(ACTOR, dish.id, { parentSlug: grandchild.slug }),
      ),
      "InvalidRelationship",
    );
  });

  test("blocks publishing until editorial checks pass, then publishes", async () => {
    const dish = await createDish(slugFor("publish"));

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishFields(ACTOR, dish.id, { status: "published" }),
      ),
      "InvalidDishData",
    );

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishDescriptions(ACTOR, dish.id, {
          upsert: [{ languageTag: "en", description: "A test dish.", summary: null }],
          removeLanguageTags: [],
        }),
      ),
    );
    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishTaxonomy(ACTOR, dish.id, {
          cuisineUpsert: [],
          cuisineRemove: [],
          categoryUpsert: ["noodles"],
          categoryRemove: [],
        }),
      ),
    );

    const published = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishFields(ACTOR, dish.id, { status: "published" }),
      ),
    );

    expect(published.id).toBe(dish.id);
    expect(published.status).toBe("published");

    const revisions = await run(
      Effect.flatMap(CurationService, (curation) => curation.listRevisions(dish.id, 10)),
    );

    expect(revisions.some((entry) => entry.operation === "status_changed")).toBe(true);
  });
});

describe("dish name updates", () => {
  test("inserts, edits in place, and swaps the preferred name without duplicates", async () => {
    const dish = await createDish(slugFor("names"));

    const added = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [{ languageTag: "vi", name: "Phở thử", nameKind: "native" }],
          removeIds: [],
        }),
      ),
    );

    expect(added.upserted).toBe(1);
    expect(added.removed).toBe(0);
    expect(added.names).toHaveLength(2);
    expect(added.names.filter((row) => row.isPreferred)).toHaveLength(2);

    const english = added.names.find((row) => row.languageTag === "en");

    // In-place edit keeps the record id.
    const edited = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [
            {
              id: english?.id ?? "0",
              languageTag: "en",
              name: "Revised test dish",
              nameKind: "localized",
            },
          ],
          removeIds: [],
        }),
      ),
    );

    expect(edited.upserted).toBe(1);
    expect(edited.names).toHaveLength(2);

    const editedRow = edited.names.find((row) => row.id === english?.id);

    expect(editedRow?.name).toBe("Revised test dish");
    expect(edited.names.filter((row) => row.languageTag === "en")).toHaveLength(1);

    // Preferred swap: the alias becomes preferred, the old row is demoted.
    const swapped = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [{ languageTag: "en", name: "Test alias", nameKind: "alias", isPreferred: true }],
          removeIds: [],
        }),
      ),
    );

    const preferredEnglish = swapped.names.filter(
      (row) => row.languageTag === "en" && row.isPreferred,
    );

    expect(preferredEnglish).toHaveLength(1);
    expect(preferredEnglish[0]?.name).toBe("Test alias");
    expect(swapped.names.filter((row) => row.languageTag === "en")).toHaveLength(2);
  });

  test("rejects removing the preferred name while siblings remain", async () => {
    const dish = await createDish(slugFor("preferred"));

    const withSibling = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [{ languageTag: "en", name: "Second name", nameKind: "alias" }],
          removeIds: [],
        }),
      ),
    );

    const preferred = withSibling.names.find((row) => row.languageTag === "en" && row.isPreferred);

    const sibling = withSibling.names.find(
      (row) => row.languageTag === "en" && row.id !== preferred?.id,
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [],
          removeIds: [preferred?.id ?? "0"],
        }),
      ),
      "InvalidDishData",
    );

    // Same removal with a replacement marked preferred succeeds.
    const outcome = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [
            {
              id: sibling?.id ?? "0",
              languageTag: "en",
              name: sibling?.name ?? "Second name",
              nameKind: "alias",
              isPreferred: true,
            },
          ],
          removeIds: [preferred?.id ?? "0"],
        }),
      ),
    );

    expect(outcome.upserted).toBe(1);
    expect(outcome.removed).toBe(1);
    expect(outcome.names).toHaveLength(1);
  });

  test("rejects duplicate and unknown name ids", async () => {
    const dish = await createDish(slugFor("nameerrors"));

    const initial = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, { upsert: [], removeIds: [] }),
      ),
    );

    const only = initial.names[0]?.id ?? "0";

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [
            { id: only, languageTag: "en", name: "One", nameKind: "localized" },
            { id: only, languageTag: "en", name: "Two", nameKind: "localized" },
          ],
          removeIds: [],
        }),
      ),
      "InvalidDishData",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [{ id: "999999999", languageTag: "en", name: "Ghost", nameKind: "alias" }],
          removeIds: [],
        }),
      ),
      "InvalidDishData",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, { upsert: [], removeIds: [only] }),
      ),
      "InvalidDishData",
    );
  });

  test("keeps one preferred name per language across en, vi, and fr", async () => {
    const dish = await createDish(slugFor("perlang"));

    const added = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [
            { languageTag: "vi", name: `Tên thử ${stamp}`, nameKind: "native" },
            { languageTag: "fr", name: `Nom essai ${stamp}`, nameKind: "localized" },
          ],
          removeIds: [],
        }),
      ),
    );

    expect(added.names.filter((row) => row.isPreferred)).toHaveLength(3);

    // Preferred swap stays inside French; en/vi keep their preferred rows.
    const swapped = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [
            {
              languageTag: "fr",
              name: `Alias français ${stamp}`,
              nameKind: "alias",
              isPreferred: true,
            },
          ],
          removeIds: [],
        }),
      ),
    );

    const frenchPreferred = swapped.names.filter(
      (row) => row.languageTag === "fr" && row.isPreferred,
    );

    expect(frenchPreferred).toHaveLength(1);
    expect(frenchPreferred[0]?.name).toBe(`Alias français ${stamp}`);
    expect(swapped.names.filter((row) => row.languageTag === "en" && row.isPreferred)).toHaveLength(
      1,
    );
    expect(swapped.names.filter((row) => row.languageTag === "vi" && row.isPreferred)).toHaveLength(
      1,
    );

    // Removing the vi preferred while a sibling survives is refused per language.
    const withSibling = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [{ languageTag: "vi", name: `Tên phụ ${stamp}`, nameKind: "alias" }],
          removeIds: [],
        }),
      ),
    );

    const viPreferred = withSibling.names.find(
      (row) => row.languageTag === "vi" && row.isPreferred,
    );

    const viSibling = withSibling.names.find(
      (row) => row.languageTag === "vi" && row.id !== viPreferred?.id,
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [],
          removeIds: [viPreferred?.id ?? "0"],
        }),
      ),
      "InvalidDishData",
    );

    // Same removal with a same-request replacement succeeds; en/fr untouched.
    const outcome = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishNames(ACTOR, dish.id, {
          upsert: [
            {
              id: viSibling?.id ?? "0",
              languageTag: "vi",
              name: viSibling?.name ?? "",
              nameKind: "alias",
              isPreferred: true,
            },
          ],
          removeIds: [viPreferred?.id ?? "0"],
        }),
      ),
    );

    expect(outcome.names.filter((row) => row.languageTag === "vi" && row.isPreferred)).toHaveLength(
      1,
    );
    expect(outcome.names.find((row) => row.languageTag === "vi" && row.isPreferred)?.name).toBe(
      viSibling?.name,
    );
    expect(outcome.names.filter((row) => row.languageTag === "en" && row.isPreferred)).toHaveLength(
      1,
    );
    expect(outcome.names.filter((row) => row.languageTag === "fr" && row.isPreferred)).toHaveLength(
      1,
    );
  });
});

describe("dish description updates", () => {
  test("upserts in place and removes by language tag", async () => {
    const dish = await createDish(slugFor("descriptions"));

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishDescriptions(ACTOR, dish.id, {
          upsert: [{ languageTag: "en", description: "First version.", summary: null }],
          removeLanguageTags: [],
        }),
      ),
    );

    const edited = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishDescriptions(ACTOR, dish.id, {
          upsert: [
            { languageTag: "en", description: "Second version.", summary: "Short." },
            { languageTag: "vi", description: "Mô tả.", summary: null },
          ],
          removeLanguageTags: [],
        }),
      ),
    );

    expect(edited.upserted).toBe(2);
    expect(edited.descriptions).toHaveLength(2);
    expect(edited.descriptions.find((row) => row.languageTag === "en")?.description).toBe(
      "Second version.",
    );

    const removed = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishDescriptions(ACTOR, dish.id, {
          upsert: [],
          removeLanguageTags: ["vi"],
        }),
      ),
    );

    expect(removed.removed).toBe(1);
    expect(removed.descriptions).toHaveLength(1);

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishDescriptions(ACTOR, dish.id, {
          upsert: [],
          removeLanguageTags: ["fr"],
        }),
      ),
      "InvalidDishData",
    );
  });
});

describe("dish ingredient updates", () => {
  test("links, changes role in place, and unlinks", async () => {
    const dish = await createDish(slugFor("ingredients"));
    const ingredientId = await seedIngredientId("beef");

    const linked = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishIngredients(ACTOR, dish.id, {
          upsert: [{ ingredientId, role: "optional" }],
          removeIngredientIds: [],
        }),
      ),
    );

    expect(linked.upserted).toBe(1);
    expect(linked.ingredients).toHaveLength(1);
    expect(linked.ingredients[0]?.role).toBe("optional");

    const relinked = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishIngredients(ACTOR, dish.id, {
          upsert: [{ ingredientId, role: "core" }],
          removeIngredientIds: [],
        }),
      ),
    );

    expect(relinked.ingredients).toHaveLength(1);
    expect(relinked.ingredients[0]?.role).toBe("core");

    const removed = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishIngredients(ACTOR, dish.id, {
          upsert: [],
          removeIngredientIds: [ingredientId],
        }),
      ),
    );

    expect(removed.removed).toBe(1);
    expect(removed.ingredients).toHaveLength(0);

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishIngredients(ACTOR, dish.id, {
          upsert: [],
          removeIngredientIds: [ingredientId],
        }),
      ),
      "InvalidDishData",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishIngredients(ACTOR, dish.id, {
          upsert: [{ ingredientId: "999999999", role: "core" }],
          removeIngredientIds: [],
        }),
      ),
      "InvalidSearchFilter",
    );
  });
});

describe("dish taxonomy updates", () => {
  test("links and unlinks cuisines and categories by slug", async () => {
    const dish = await createDish(slugFor("taxonomy"));

    const linked = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishTaxonomy(ACTOR, dish.id, {
          cuisineUpsert: ["vietnamese"],
          cuisineRemove: [],
          categoryUpsert: ["noodles", "soup"],
          categoryRemove: [],
        }),
      ),
    );

    expect(linked.cuisines).toEqual(["vietnamese"]);
    expect(linked.categories).toEqual(["noodles", "soup"]);

    const unlinked = await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishTaxonomy(ACTOR, dish.id, {
          cuisineUpsert: [],
          cuisineRemove: ["vietnamese"],
          categoryUpsert: [],
          categoryRemove: ["soup"],
        }),
      ),
    );

    expect(unlinked.cuisinesUnlinked).toBe(1);
    expect(unlinked.categoriesUnlinked).toBe(1);
    expect(unlinked.cuisines).toHaveLength(0);
    expect(unlinked.categories).toEqual(["noodles"]);

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishTaxonomy(ACTOR, dish.id, {
          cuisineUpsert: [],
          cuisineRemove: ["vietnamese"],
          categoryUpsert: [],
          categoryRemove: [],
        }),
      ),
      "InvalidDishData",
    );

    await expectFailure(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishTaxonomy(ACTOR, dish.id, {
          cuisineUpsert: ["no-such-cuisine"],
          cuisineRemove: [],
          categoryUpsert: [],
          categoryRemove: [],
        }),
      ),
      "InvalidSearchFilter",
    );
  });
});

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBeTruthy();
});

afterAll(async () => {
  const { Database } = await import("@/server/database/client");

  if (createdSlugs.length === 0) {
    return;
  }

  await appRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;

      for (const slug of createdSlugs) {
        if (!slug.startsWith("upd-names-")) {
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
