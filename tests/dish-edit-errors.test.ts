import { describe, expect, test } from "bun:test";

import { dishEditFailureMessage } from "@/components/admin/dish/section-editor";
import type { DishEditFailure } from "@/modules/food-discovery/admin.functions";
import { messagesFor, type Messages } from "@/shared/i18n";

const copy: Messages = {
  ...messagesFor("en"),
  authDenied: "AUTH-DENIED",
  adminSaveFailed: "SAVE-FAILED",
  adminPlaceAmbiguousHint: "HINT-AMBIGUOUS",
  adminPlaceNeedsRegistration: "HINT-REGISTER",
};

const failure = (outcome: DishEditFailure): string => dishEditFailureMessage(outcome, copy);

describe("dishEditFailureMessage", () => {
  test("unknown place preserves the server reason and appends the registration hint", () => {
    const outcome: DishEditFailure = {
      ok: false,
      code: "unknown_place",
      reason: 'unknown place "Mumbai in IN"',
    };

    expect(failure(outcome)).toBe('unknown place "Mumbai in IN" HINT-REGISTER');
  });

  test("ambiguous place prefixes the hint and preserves the candidate list", () => {
    const outcome: DishEditFailure = {
      ok: false,
      code: "ambiguous_place",
      reason: 'ambiguous city "Springfield": 1: Springfield, US; 2: Springfield, AU',
    };

    expect(failure(outcome)).toBe(
      'HINT-AMBIGUOUS ambiguous city "Springfield": 1: Springfield, US; 2: Springfield, AU',
    );
  });

  test("unknown id and invalid ISO surface verbatim as invalid references", () => {
    const unknownId: DishEditFailure = {
      ok: false,
      code: "unknown_place",
      reason: "unknown place id",
    };

    const invalidIso: DishEditFailure = {
      ok: false,
      code: "invalid_reference",
      reason: 'invalid place iso "XX"',
    };

    expect(failure(unknownId)).toContain("unknown place id");
    expect(failure(invalidIso)).toBe('invalid place iso "XX"');
  });

  test("duplicate place and overlong note surface verbatim", () => {
    const duplicate: DishEditFailure = {
      ok: false,
      code: "invalid_reference",
      reason: "duplicate place in request",
    };

    expect(failure(duplicate)).toBe("duplicate place in request");
  });

  test("conflicts and missing dishes surface verbatim", () => {
    const conflict: DishEditFailure = {
      ok: false,
      code: "conflict",
      reason: "dish slug is taken",
    };

    const missing: DishEditFailure = {
      ok: false,
      code: "not_found",
      reason: "Dish 42 was not found.",
    };

    expect(failure(conflict)).toBe("dish slug is taken");
    expect(failure(missing)).toBe("Dish 42 was not found.");
  });

  test("forbidden maps to authDenied without leaking internals", () => {
    const outcome: DishEditFailure = {
      ok: false,
      code: "forbidden",
      reason: "Administration requires food:update.",
    };

    expect(failure(outcome)).toBe("AUTH-DENIED");
  });

  test("every failure code maps to a specific message, never the generic fallback", () => {
    const codes: ReadonlyArray<DishEditFailure["code"]> = [
      "unknown_place",
      "ambiguous_place",
      "invalid_reference",
      "conflict",
      "not_found",
      "forbidden",
    ];

    for (const code of codes) {
      expect(failure({ ok: false, code, reason: "detail" })).not.toBe("SAVE-FAILED");
    }
  });
});
