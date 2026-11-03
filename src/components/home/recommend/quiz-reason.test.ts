import { describe, expect, test } from "bun:test";

import {
  cleanReasonForDisplay,
  MAX_DISPLAY_REASON_LENGTH,
} from "@/components/home/recommend/quiz-status";

/**
 * Agent C — per-dish Muse reason display pins (PR §6).
 *
 * DB-free and DOM-free: the pure display cleaner behind SelectedDishReason.
 * Provenance gating (LiveMuse only) lives in quiz-flow's renderOutcome and
 * the component itself; these pins cover the second half — never present
 * arbitrary text as a personalized reason, never leak control characters
 * or overlong model output into the layout.
 */
describe("cleanReasonForDisplay", () => {
  test("passes grounded short reasons through untouched", () => {
    const reason = "Comforting noodle soup that fits a cozy dinner";

    expect(cleanReasonForDisplay(reason)).toBe(reason);
  });

  test("rejects blanks and control characters", () => {
    expect(cleanReasonForDisplay(undefined)).toBeNull();
    expect(cleanReasonForDisplay(null)).toBeNull();
    // Non-strings never reach this layer: the service Schema boundary
    // rejects them before ranking results are transported.
    expect(cleanReasonForDisplay("   ")).toBeNull();
    expect(cleanReasonForDisplay("Great pick\u0000 tonight")).toBe("Great pick tonight");
    expect(cleanReasonForDisplay("Great pick\u2028 tonight")).toBe("Great pick tonight");
  });

  test("truncates to the display bound (mobile clamp never breaks layout)", () => {
    const long = "x".repeat(MAX_DISPLAY_REASON_LENGTH + 100);
    const cleaned = cleanReasonForDisplay(long);

    if (cleaned === null) {
      throw new Error("expected a cleaned reason");
    }

    expect(cleaned).toHaveLength(MAX_DISPLAY_REASON_LENGTH);
  });

  test("passes two-to-three-sentence reasons through untouched", () => {
    const reason =
      "Rich, aromatic broth with tender beef and fresh herbs. It fits your comforting dinner mood. A warm, satisfying bowl for the evening.";

    expect(cleanReasonForDisplay(reason)).toBe(reason);
  });

  test("truncates long multilingual reasons to the display bound", () => {
    const long = "Nước dùng đậm đà với thịt bò mềm và rau thơm tươi Ngon tuyệt ".repeat(10);
    const cleaned = cleanReasonForDisplay(long);

    expect(cleaned).not.toBeNull();
    expect(cleaned).toHaveLength(MAX_DISPLAY_REASON_LENGTH);
  });

  test("trims surrounding whitespace", () => {
    expect(cleanReasonForDisplay("  Lovely regional pick  ")).toBe("Lovely regional pick");
  });
});
