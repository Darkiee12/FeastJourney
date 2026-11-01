import { describe, expect, test } from "bun:test";

import {
  DRAWER_SPRING_FALLBACK_MS,
  parseDrawerDurationMs,
} from "@/components/home/recommend/quiz-drawer";

describe("parseDrawerDurationMs", () => {
  test("parses the shared millisecond token", () => {
    expect(parseDrawerDurationMs("450ms")).toBe(450);
    expect(parseDrawerDurationMs(" 450ms ")).toBe(450);
    expect(parseDrawerDurationMs("450MS")).toBe(450);
  });

  test("parses second tokens into milliseconds", () => {
    expect(parseDrawerDurationMs("0.45s")).toBe(450);
    expect(parseDrawerDurationMs("1s")).toBe(1000);
  });

  test("falls back on missing, garbage, negative, or non-finite input", () => {
    expect(parseDrawerDurationMs("")).toBe(DRAWER_SPRING_FALLBACK_MS);
    expect(parseDrawerDurationMs("fast")).toBe(DRAWER_SPRING_FALLBACK_MS);
    expect(parseDrawerDurationMs("450")).toBe(DRAWER_SPRING_FALLBACK_MS);
    expect(parseDrawerDurationMs("-100ms")).toBe(DRAWER_SPRING_FALLBACK_MS);
    expect(parseDrawerDurationMs("Infinityms")).toBe(DRAWER_SPRING_FALLBACK_MS);
  });
});
