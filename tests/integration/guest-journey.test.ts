import { afterAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import {
  buildSurprisePayload,
  draftFromSavedPrefs,
  EMPTY_DRAFT,
  readSavedPrefs,
} from "@/components/home/recommend-section";
import { CatalogService } from "@/modules/food-discovery/server/operations/catalog-service";
import { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import { addFavoriteFn, listFavoritesFn, removeFavoriteFn } from "@/modules/user/profile.functions";
import { FavoritesService } from "@/modules/user/server/operations/user-services";
import type { FavoriteRow } from "@/modules/user/server/repository/user-repository";
import { classifySessionFailure, sessionFailureSchema } from "@/modules/user/session.functions";
import type { SessionState } from "@/modules/user/session.functions";
import { SignInRequired, UserSuspended } from "@/server/auth/errors";
import { resolveSession, requirePermission } from "@/server/auth/session";
import { DatabaseUnavailable } from "@/server/database/errors";
import type { AppServices } from "@/server/layers";
import { appRuntime, RequestTimeout } from "@/server/runtime";

import { createFoodAuth } from "./food-auth";
// oxlint-disable-next-line import/no-unassigned-import -- seeds disposable-DB and auth env guards at import time; this file owns no fixtures.
import "./cleanup";

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

const flipRun = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<E> =>
  appRuntime.runPromise(Effect.flip(effect));

const foodAuth = createFoodAuth();

afterAll(() => foodAuth.close());

describe("guest journey: public catalog discovery", () => {
  test("empty-q search returns published dishes for homepage cards", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) => service.searchDishes({ locale: "en", limit: 5 })),
    );

    expect(output.items.length).toBeGreaterThan(0);

    for (const item of output.items) {
      expect(item.slug.length).toBeGreaterThan(0);
      expect(item.id).toMatch(/^[0-9]+$/);
    }
  });

  test("unknown dish id fails with a stable DishNotFound tag (no message sniffing)", async () => {
    const failure = await flipRun(
      Effect.flatMap(DishService, (service) => service.getDish("no-such-dish-000", "en")),
    );

    expect(failure._tag).toBe("DishNotFound");
  });

  test("place listing serves the country chooser without new SQL", async () => {
    const places = await run(
      Effect.flatMap(CatalogService, (service) => service.listPlaces("en", 100)),
    );

    const coded = places.filter((entry) => entry.iso3166 !== null);

    expect(coded.length).toBeGreaterThan(0);

    for (const entry of coded) {
      expect(entry.iso3166).toMatch(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);
    }
  });

  test("saved list paginates beyond the first page", async () => {
    const member = await foodAuth.signupSignin("pagedsaver");

    await foodAuth.grantRole(member.userId, "member");

    const found = await run(
      Effect.flatMap(DishService, (service) => service.searchDishes({ locale: "en", limit: 3 })),
    );

    const ids = found.items.map((item) => item.id);

    expect(ids.length).toBe(3);

    await Promise.all(
      ids.map((id) =>
        run(Effect.flatMap(FavoritesService, (service) => service.addFavorite(member.userId, id))),
      ),
    );

    try {
      const page1 = await run(
        Effect.flatMap(FavoritesService, (service) => service.listFavorites(member.userId, 2, 0)),
      );

      const page2 = await run(
        Effect.flatMap(FavoritesService, (service) => service.listFavorites(member.userId, 2, 2)),
      );

      const favoriteRowSchema = z.object({ dish_id: z.string() });

      const pageIds = (rows: ReadonlyArray<FavoriteRow>): Array<string> =>
        rows.map((row) => favoriteRowSchema.parse(row).dish_id);

      const allIds = [...pageIds(page1), ...pageIds(page2)];

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(new Set(allIds).size).toBe(3);
    } finally {
      await Promise.allSettled(
        ids.map((id) =>
          run(
            Effect.flatMap(FavoritesService, (service) =>
              service.removeFavorite(member.userId, id),
            ),
          ),
        ),
      );
    }
  });

  test("country listing returns only countries even past a 100-place limit", async () => {
    const sql = new SQL(process.env["DATABASE_URL"] ?? "");
    const placeIdSchema = z.object({ id: z.coerce.bigint() });
    let localityIds: Array<bigint> = [];

    try {
      const localityRows: unknown = await sql`INSERT INTO feastjourney.places
        (kind, iso3166, display_latitude, display_longitude)
        SELECT 'locality', NULL, 0, 0 FROM generate_series(1, 110)
        RETURNING id`;

      localityIds = z
        .array(placeIdSchema)
        .parse(localityRows)
        .map((row) => row.id);

      expect(localityIds).toHaveLength(110);

      const countryRows: unknown = await sql`INSERT INTO feastjourney.places
        (kind, iso3166, display_latitude, display_longitude)
        VALUES ('country', 'QX', 0, 0)
        RETURNING id`;

      const [countryRow] = z.array(placeIdSchema).parse(countryRows);

      if (countryRow === undefined) {
        throw new Error("country fixture insert returned no row");
      }

      await sql`INSERT INTO feastjourney.place_names
        (place_id, language_tag, name, is_preferred, search_key)
        VALUES (${countryRow.id}, 'en', 'Test Country QX', true, 'test country qx')`;

      const countries = await run(
        Effect.flatMap(CatalogService, (service) => service.listCountries("en", 250)),
      );

      expect(countries.length).toBeGreaterThan(0);

      for (const entry of countries) {
        expect(entry.kind).toBe("country");
        expect(entry.iso3166).toMatch(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);
      }

      const found = countries.find((entry) => entry.iso3166 === "QX");

      expect(found?.displayName).toBe("Test Country QX");
    } finally {
      await sql`DELETE FROM feastjourney.place_names WHERE name = 'Test Country QX'`;
      await sql`DELETE FROM feastjourney.places WHERE iso3166 = 'QX'`;

      if (localityIds.length > 0) {
        await sql`DELETE FROM feastjourney.places WHERE id = ANY(${sql.array(localityIds)})`;
      }

      await sql.end();
    }
  });

  test("batch summaries resolve many saved ids in one call, skipping unknown rows", async () => {
    const found = await run(
      Effect.flatMap(DishService, (service) => service.searchDishes({ locale: "en", limit: 3 })),
    );

    expect(found.items.length).toBeGreaterThan(0);

    const ids = found.items.map((item) => item.id);

    const summaries = await run(
      Effect.flatMap(DishService, (service) => service.getDishSummaries(ids, "en")),
    );

    expect(summaries.map((dish) => dish.id)).toEqual(ids);

    const partial = await run(
      Effect.flatMap(DishService, (service) =>
        service.getDishSummaries(
          [...ids.slice(0, 1), "999999999", "not-an-id", ...ids.slice(0, 1)],
          "en",
        ),
      ),
    );

    expect(partial.map((dish) => dish.id)).toEqual(ids.slice(0, 1));
  });
});

describe("guest journey: surprise keeps restrictions", () => {
  test("surprise payload preserves exclusions and country", () => {
    const draft = {
      ...EMPTY_DRAFT,
      excludedRaw: "cilantro, mushrooms, peanuts",
      regionMode: "country" as const,
      country: "vn",
      remember: false,
    };

    const payload = buildSurprisePayload({
      draft,
      meal: "dinner",
      mood: "any",
      locale: "en",
      surpriseSeed: 0,
    });

    expect(payload.excludedIngredients).toEqual(["cilantro", "mushrooms", "peanuts"]);
    expect(payload.country).toBe("VN");
    expect(payload.meal).toBe("dinner");
  });

  test("surprise payload preserves the restored country lane", () => {
    const draft = {
      ...EMPTY_DRAFT,
      regionMode: "country" as const,
      country: "JP",
    };

    const payload = buildSurprisePayload({
      draft,
      meal: "lunch",
      mood: "surprise",
      locale: "vi",
      surpriseSeed: 1,
    });

    expect(payload.country).toBe("JP");
    expect(payload.locale).toBe("vi");
  });

  test("saved prefs restore exclusions and destination, never meal or mood", () => {
    const saved = readSavedPrefs(() =>
      JSON.stringify({
        remember: true,
        excludedIngredients: ["cilantro"],
        country: "VN",
      }),
    );

    const draft = draftFromSavedPrefs(saved);

    expect(draft.excludedRaw).toBe("cilantro");
    expect(draft.regionMode).toBe("country");
  });
});

const classified = (
  failure: DatabaseUnavailable | RequestTimeout | SignInRequired | UserSuspended | Error,
): SessionState => classifySessionFailure(sessionFailureSchema.safeParse(failure));

describe("guest journey: sessions and member-only mutations", () => {
  test("empty headers resolve to SignInRequired (signed-out, never member)", async () => {
    const failure = await flipRun(resolveSession(new Headers()));

    expect(failure._tag).toBe("SignInRequired");
    expect(classified(failure)).toEqual({ status: "signed-out" });
  });

  test("store outages classify as unavailable, auth failures as signed-out", () => {
    expect(classified(new DatabaseUnavailable({ operation: "test" }))).toEqual({
      status: "unavailable",
    });

    expect(classified(new RequestTimeout({ operation: "test" }))).toEqual({
      status: "unavailable",
    });

    expect(classified(new SignInRequired({ required: "member" }))).toEqual({
      status: "signed-out",
    });

    expect(classified(new UserSuspended({ reason: "test" }))).toEqual({ status: "signed-out" });

    // Unknown failures are infrastructure ambiguity, never proof of logout.
    expect(classified(new Error("boom"))).toEqual({ status: "unavailable" });
  });

  test("favorites gate allows members, denies guests (server-enforced)", async () => {
    const member = await foodAuth.signupSignin("guestjourney");

    await foodAuth.grantRole(member.userId, "member");

    const trusted = await run(
      requirePermission(new Headers({ cookie: member.cookies }), {
        resource: "favorite",
        actions: ["create"],
      }),
    );

    expect(trusted.userId).toBe(member.userId);

    const denied = await flipRun(
      requirePermission(new Headers(), { resource: "favorite", actions: ["create"] }),
    );

    expect(denied._tag).toBe("SignInRequired");
  });

  test("favorites mutations reject logged-out callers", async () => {
    const outcomes = await Promise.allSettled([
      listFavoritesFn({ data: { limit: 20 } }),
      addFavoriteFn({ data: { dish_id: "1" } }),
      removeFavoriteFn({ data: { dish_id: "1" } }),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
  });
});
