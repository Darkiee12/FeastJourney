// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";

import { ProfileService } from "@/modules/user/server/operations/user-services";
import { foodPreferencesUpdateSchema } from "@/modules/user/user.schema";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

const run = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> =>
  appRuntime.runPromise(effect);

const stamp = Date.now().toString(36);
const userIdOf = (name: string): string => `prefs-${name}-${stamp}`;

const createdUserIds: Array<string> = [];

const createUser = async (userId: string): Promise<void> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  await sql`INSERT INTO "feastjourney"."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (${userId}, ${userId}, ${`${userId}@example.com`}, true, now(), now())`;
  await sql.end();
  createdUserIds.push(userId);
};

beforeAll(async () => {
  expect(process.env.DATABASE_URL).toBeTruthy();
  await createUser(userIdOf("alice"));
  await createUser(userIdOf("bob"));
});

afterAll(async () => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  await Promise.all(
    createdUserIds.map((id) => sql`DELETE FROM "feastjourney"."user" WHERE id = ${id}`),
  );

  await sql.end();
});

describe("member food preferences", () => {
  test("reads return null when the member never saved any", async () => {
    const prefs = await run(
      Effect.flatMap(ProfileService, (service) => service.getFoodPreferences(userIdOf("alice"))),
    );

    expect(prefs).toBeNull();
  });

  test("saving then reading round-trips the exclusion list", async () => {
    const userId = userIdOf("alice");

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.saveFoodPreferences({ userId, excludedIngredients: ["peanuts", "pork"] }),
      ),
    );

    const prefs = await run(
      Effect.flatMap(ProfileService, (service) => service.getFoodPreferences(userId)),
    );

    expect(prefs?.excluded_ingredients).toEqual(["peanuts", "pork"]);

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.saveFoodPreferences({ userId, excludedIngredients: ["cilantro"] }),
      ),
    );

    const replaced = await run(
      Effect.flatMap(ProfileService, (service) => service.getFoodPreferences(userId)),
    );

    expect(replaced?.excluded_ingredients).toEqual(["cilantro"]);
  });

  test("two accounts never share exclusions", async () => {
    const alice = userIdOf("alice");
    const bob = userIdOf("bob");

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.saveFoodPreferences({ userId: alice, excludedIngredients: ["peanuts"] }),
      ),
    );

    const bobPrefs = await run(
      Effect.flatMap(ProfileService, (service) => service.getFoodPreferences(bob)),
    );

    expect(bobPrefs).toBeNull();

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.saveFoodPreferences({ userId: bob, excludedIngredients: ["shellfish"] }),
      ),
    );

    const alicePrefs = await run(
      Effect.flatMap(ProfileService, (service) => service.getFoodPreferences(alice)),
    );

    expect(alicePrefs?.excluded_ingredients).toEqual(["peanuts"]);
  });

  test("preference writes never clobber display_name/locale and vice versa", async () => {
    const userId = userIdOf("bob");

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.updateProfile({ userId, displayName: "Bob", locale: "vi" }),
      ),
    );

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.saveFoodPreferences({ userId, excludedIngredients: ["pork"] }),
      ),
    );

    const profile = await run(
      Effect.flatMap(ProfileService, (service) => service.getProfile(userId)),
    );

    expect(profile?.display_name).toBe("Bob");
    expect(profile?.locale).toBe("vi");

    await run(
      Effect.flatMap(ProfileService, (service) =>
        service.updateProfile({ userId, displayName: "Bobby", locale: "en" }),
      ),
    );

    const prefs = await run(
      Effect.flatMap(ProfileService, (service) => service.getFoodPreferences(userId)),
    );

    expect(prefs?.excluded_ingredients).toEqual(["pork"]);

    const updated = await run(
      Effect.flatMap(ProfileService, (service) => service.getProfile(userId)),
    );

    expect(updated?.display_name).toBe("Bobby");
    expect(updated?.locale).toBe("en");
  });
});

describe("food preferences transport validation", () => {
  test("trims, drops empties, and dedupes while preserving order", () => {
    const parsed = foodPreferencesUpdateSchema.parse({
      excluded_ingredients: [" pork ", "", "pork", "peanuts", "  "],
    });

    expect(parsed.excluded_ingredients).toEqual(["pork", "peanuts"]);
  });

  test("rejects more than 20 items instead of truncating", () => {
    const items = Array.from({ length: 21 }, (_, index) => `item-${index}`);

    expect(() => foodPreferencesUpdateSchema.parse({ excluded_ingredients: items })).toThrow();
  });

  test("rejects any item longer than 100 characters", () => {
    expect(() =>
      foodPreferencesUpdateSchema.parse({ excluded_ingredients: ["x".repeat(101)] }),
    ).toThrow();
  });
});
