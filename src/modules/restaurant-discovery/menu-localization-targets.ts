import { z } from "zod";

/**
 * Menu-localization targets: the seven review-gated reading languages plus
 * explicit styles that curator columns cannot hold. Malay (ms) and Hindi
 * (hi) are machine-only targets; hinglish is a presentation style layered
 * over English, never a silent relabel. Client-safe: server generation,
 * server functions, and the panel hook all share this single list.
 */

export const localizationTargets = [
  "en",
  "vi",
  "ja",
  "zh",
  "ko",
  "fr",
  "es",
  "ms",
  "hi",
  "hinglish",
] as const;

export type LocalizationTarget = (typeof localizationTargets)[number];

export const localizationTargetSchema = z.enum(localizationTargets);

/** Pre-enrich accepts at most this many targets per request (transport bound, shared client/server). */
export const MAX_PRE_ENRICH_TARGETS = 10;
