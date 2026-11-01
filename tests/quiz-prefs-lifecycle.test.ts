import { describe, expect, test } from "bun:test";

import {
  draftFromSavedPrefs,
  EMPTY_DRAFT,
  needsAccountPrefill,
  persistPrefs,
  PREFS_STORAGE_KEY,
  readStoredPrefs,
  removeSavedPrefs,
  resolvePersistedExclusions,
  sameExclusionSet,
  shouldShowImportBanner,
} from "@/components/home/recommend-section";

/**
 * Preference-lifecycle regression coverage for the unified exclusions
 * (guest localStorage vs member account, no cross-mirroring):
 *
 * - guest -> sign-in -> edit -> sign-out transitions
 * - account switching (user A state never leaks into user B)
 * - save -> Skip (Skip reverts to the freshly persisted list)
 * - clear -> reload (nothing reappears)
 *
 * The React Query cache writes themselves live in quiz-flow.tsx; the
 * branching decisions they depend on are the pure helpers under test
 * here, and the guest flows are additionally covered end to end in
 * Playwright (see the implementation summary).
 */
describe("persisted exclusions source selection", () => {
  test("guests always use the guest mirror", () => {
    expect(
      resolvePersistedExclusions({
        userId: null,
        accountLoaded: false,
        account: null,
        guest: ["cilantro"],
      }),
    ).toEqual(["cilantro"]);
  });

  test("signed-in members use the loaded account list", () => {
    expect(
      resolvePersistedExclusions({
        userId: "member-a",
        accountLoaded: true,
        account: ["peanuts"],
        guest: ["cilantro"],
      }),
    ).toEqual(["peanuts"]);
  });

  test("a member whose account prefs are still loading falls back to guest (matches the visible draft)", () => {
    expect(
      resolvePersistedExclusions({
        userId: "member-a",
        accountLoaded: false,
        account: null,
        guest: ["cilantro"],
      }),
    ).toEqual(["cilantro"]);
  });

  test("an empty loaded account resolves empty, never guest values", () => {
    expect(
      resolvePersistedExclusions({
        userId: "member-a",
        accountLoaded: true,
        account: [],
        guest: ["cilantro"],
      }),
    ).toEqual([]);
  });

  test("after an account save, Skip observes the saved values (no stale restore)", () => {
    // Simulates queryClient.setQueryData on save success: the next
    // persistedExclusions() call sees the fresh account list.
    const afterSave = resolvePersistedExclusions({
      userId: "member-a",
      accountLoaded: true,
      account: ["peanuts", "shrimp"],
      guest: ["cilantro"],
    });

    expect(afterSave).toEqual(["peanuts", "shrimp"]);
  });
});

describe("account prefill gating", () => {
  const loaded = {
    signedIn: true,
    prefilledForUserId: null,
    userId: "member-a",
    accountLoaded: true,
    excludedTouched: false,
    accountNonEmpty: true,
  };

  test("prefills once for a pristine draft with saved account prefs", () => {
    expect(needsAccountPrefill(loaded)).toBe(true);
  });

  test("never prefills for guests", () => {
    expect(needsAccountPrefill({ ...loaded, signedIn: false, userId: null })).toBe(false);
  });

  test("never overwrites newer user edits, even after the account load lands", () => {
    expect(needsAccountPrefill({ ...loaded, excludedTouched: true })).toBe(false);
  });

  test("never prefills twice for the same account", () => {
    expect(needsAccountPrefill({ ...loaded, prefilledForUserId: "member-a" })).toBe(false);
  });

  test("an account switch re-arms the prefill for the new member", () => {
    expect(
      needsAccountPrefill({ ...loaded, prefilledForUserId: "member-a", userId: "member-b" }),
    ).toBe(true);
  });

  test("an empty account never wipes guest-restored text", () => {
    expect(needsAccountPrefill({ ...loaded, accountNonEmpty: false })).toBe(false);
  });

  test("a still-loading account never prefills", () => {
    expect(needsAccountPrefill({ ...loaded, accountLoaded: false })).toBe(false);
  });
});

describe("import banner visibility", () => {
  const loaded = {
    signedIn: true,
    accountLoaded: true,
    dismissed: false,
    guest: ["cilantro"],
    account: ["peanuts"],
  };

  test("shows when guest and account differ", () => {
    expect(shouldShowImportBanner(loaded)).toBe(true);
  });

  test("hides for guests", () => {
    expect(shouldShowImportBanner({ ...loaded, signedIn: false })).toBe(false);
  });

  test("hides while the account prefs are still loading", () => {
    expect(shouldShowImportBanner({ ...loaded, accountLoaded: false })).toBe(false);
  });

  test("stays dismissed for the visit", () => {
    expect(shouldShowImportBanner({ ...loaded, dismissed: true })).toBe(false);
  });

  test("hides when both sides are empty", () => {
    expect(shouldShowImportBanner({ ...loaded, guest: [], account: [] })).toBe(false);
  });

  test("a bare reorder does not nag for an import", () => {
    expect(shouldShowImportBanner({ ...loaded, guest: ["b", "a"], account: ["a", "b"] })).toBe(
      false,
    );
  });
});

describe("exclusion set comparison", () => {
  test("order-insensitive equality", () => {
    expect(sameExclusionSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameExclusionSet([], [])).toBe(true);
    expect(sameExclusionSet(["a"], ["a", "b"])).toBe(false);
    expect(sameExclusionSet(["a"], ["b"])).toBe(false);
  });
});

const withFakeWindow = (store: Map<string, string>, run: () => void): void => {
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };

  Object.defineProperty(globalThis, "window", {
    value: fakeWindow,
    configurable: true,
    writable: true,
  });

  try {
    run();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
};

describe("guest clear -> reload", () => {
  test("saved guest prefs round-trip, then cleared values do not reappear", () => {
    const store = new Map<string, string>();

    withFakeWindow(store, () => {
      persistPrefs({
        rememberDestination: true,
        excludedIngredients: ["cilantro", "peanuts"],
        country: "VN",
      });

      const raw = store.get(PREFS_STORAGE_KEY) ?? "";
      expect(raw).toContain('"excludedIngredients"');
      expect(raw).toContain("cilantro");
      expect(raw).not.toContain("precise");
      expect(raw).not.toContain("latitude");

      // Skip observes exactly what was persisted.
      expect(
        resolvePersistedExclusions({
          userId: null,
          accountLoaded: false,
          account: null,
          guest: ["cilantro", "peanuts"],
        }),
      ).toEqual(["cilantro", "peanuts"]);

      // Clear removes the key; a reload restores nothing.
      removeSavedPrefs(() => window.localStorage.removeItem(PREFS_STORAGE_KEY));
      expect(store.has(PREFS_STORAGE_KEY)).toBe(false);
      expect(readStoredPrefs()).toBeNull();
      expect(draftFromSavedPrefs(readStoredPrefs())).toEqual(EMPTY_DRAFT);
    });
  });

  test("an empty exclusion list with no remembered destination removes the key", () => {
    const store = new Map<string, string>([[PREFS_STORAGE_KEY, "{}"]]);

    withFakeWindow(store, () => {
      persistPrefs({ rememberDestination: false, excludedIngredients: [] });
      expect(store.has(PREFS_STORAGE_KEY)).toBe(false);
    });
  });

  test("guest submits always carry the persisted values after save (save -> Skip)", () => {
    const store = new Map<string, string>();

    withFakeWindow(store, () => {
      // First submit persists.
      persistPrefs({ rememberDestination: false, excludedIngredients: ["pork", "shrimp"] });

      // A later Skip re-reads storage (never a stale in-memory copy).
      expect(readStoredPrefs()?.excludedIngredients).toEqual(["pork", "shrimp"]);
    });
  });
});
