import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  agentPresenceStatusText,
  agentStageLineFor,
  MusePresence,
} from "@/components/home/recommend/muse-presence";
import { ResultsLoadingSkeleton } from "@/components/home/recommend/results-loading";
import type { ProgressStage } from "@/modules/food-discovery/server/agent/protocol";
import { messagesFor } from "@/shared/i18n";

const copyEn = messagesFor("en");
const copyVi = messagesFor("vi");

const ACTIVE_STAGES: ReadonlyArray<ProgressStage> = [
  "preparing",
  "searching-catalog",
  "muse-curating",
  "inspecting-dishes",
  "finalizing",
];

const renderPresence = (
  stage: ProgressStage | null,
  live: boolean,
  compact = false,
  lang: "en" | "vi" = "en",
): string =>
  renderToStaticMarkup(
    createElement(MusePresence, {
      copy: messagesFor(lang),
      stage,
      live,
      compact,
    }),
  );

/**
 * Muse presence (workstream C): the animated overlay inside the existing
 * featured-image placeholder. Live runs show the title plus one genuine
 * backend stage line; every neutral path (deterministic, degraded, guest,
 * pre-stream, terminal) renders nothing visible and keeps the plain
 * skeleton with a single sr-only announcement.
 */
describe("muse presence honesty", () => {
  test("neutral states render no visible Muse copy", () => {
    expect(renderPresence("muse-curating", false)).toBe("");
    expect(renderPresence(null, false)).toBe("");
    expect(renderPresence(null, true)).toBe("");
    expect(renderPresence("completed", true)).toBe("");
    expect(renderPresence("degraded", true)).toBe("");
    expect(renderPresence("failed", true)).toBe("");
  });

  test("live stages render the title plus the genuine stage line", () => {
    const html = renderPresence("muse-curating", true);

    expect(html).toContain(copyEn.recAgentTitle);
    expect(html).toContain(copyEn.recAgentCurating);
    expect(html).not.toContain(copyEn.recAgentSearching);
  });

  test("each active stage maps to a distinct, non-empty line", () => {
    const lines = ACTIVE_STAGES.map((stage) => agentStageLineFor(stage, copyEn));

    expect(lines.every((line) => line !== null && line.length > 0)).toBe(true);
    expect(new Set(lines).size).toBe(ACTIVE_STAGES.length);
    expect(agentStageLineFor("completed", copyEn)).toBe(null);
    expect(agentStageLineFor("failed", copyEn)).toBe(null);
  });

  test("secondary lines are stage-driven, never shared across stages", () => {
    expect(renderPresence("searching-catalog", true)).toContain(copyEn.recAgentSearching);
    expect(renderPresence("inspecting-dishes", true)).toContain(copyEn.recAgentInspecting);
    expect(renderPresence("finalizing", true)).toContain(copyEn.recAgentFinalizing);
    expect(renderPresence("preparing", true)).toContain(copyEn.recAgentPreparing);
  });

  test("compact variant keeps the same copy at a smaller footprint", () => {
    const html = renderPresence("searching-catalog", true, true);

    expect(html).toContain(copyEn.recAgentTitle);
    expect(html).toContain(copyEn.recAgentSearching);
    expect(html).toContain("size-9");
  });
});

describe("muse presence accessibility", () => {
  test("visible overlay is decorative; announcements come from the sr line", () => {
    const html = renderPresence("finalizing", true);

    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("role=");
  });

  test("motion collapses under reduced-motion settings", () => {
    const html = renderPresence("preparing", true);

    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("motion-safe:animate-rec-step-enter");
  });

  test("status text is neutral until a live stage arrives, then combines title and line", () => {
    expect(agentPresenceStatusText(copyEn, null, false)).toBe(copyEn.recLoading);
    expect(agentPresenceStatusText(copyEn, "muse-curating", false)).toBe(copyEn.recLoading);
    expect(agentPresenceStatusText(copyEn, "completed", true)).toBe(copyEn.recLoading);
    expect(agentPresenceStatusText(copyEn, "failed", true)).toBe(copyEn.recLoading);

    const live = agentPresenceStatusText(copyEn, "inspecting-dishes", true);

    expect(live).toContain(copyEn.recAgentTitle);
    expect(live).toContain(copyEn.recAgentInspecting);
  });
});

describe("muse presence localization", () => {
  test("Vietnamese renders translated copy with no English stage lines", () => {
    const html = renderPresence("muse-curating", true, false, "vi");

    expect(html).toContain(copyVi.recAgentTitle);
    expect(html).toContain(copyVi.recAgentCurating);
    expect(html).not.toContain("Taking a closer look");
    expect(html).not.toContain("Getting your recommendations ready");
    expect(html).not.toContain("Muse is curating your picks");
  });

  test("every display locale resolves all six presence keys", () => {
    const locales = ["en", "vi", "hi", "es", "zh", "ja", "de", "nl"] as const;

    for (const lang of locales) {
      const copy = messagesFor(lang);

      expect(copy.recAgentTitle.length).toBeGreaterThan(0);
      expect(copy.recAgentPreparing.length).toBeGreaterThan(0);
      expect(copy.recAgentSearching.length).toBeGreaterThan(0);
      expect(copy.recAgentCurating.length).toBeGreaterThan(0);
      expect(copy.recAgentInspecting.length).toBeGreaterThan(0);
      expect(copy.recAgentFinalizing.length).toBeGreaterThan(0);
    }
  });
});

describe("results loading with live progress", () => {
  test("neutral skeleton is unchanged: no Muse copy, single recLoading announcement", () => {
    const html = renderToStaticMarkup(createElement(ResultsLoadingSkeleton, { copy: copyEn }));

    expect(html).toContain(copyEn.recLoading);
    expect(html).not.toContain(copyEn.recAgentTitle);
  });

  test("live progress overlays the media frame without duplicating status", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsLoadingSkeleton, {
        copy: copyEn,
        presence: { stage: "searching-catalog", live: true },
      }),
    );

    expect(html).toContain(copyEn.recAgentTitle);
    expect(html).toContain(copyEn.recAgentSearching);
    expect(html).toContain("pointer-events-none absolute");

    // The sr-only line switches to the live text; the overlay itself is decorative.
    expect(html).toContain("sr-only");
    expect(html).not.toContain(copyEn.recLoading);
  });

  test("non-live presence input keeps the neutral skeleton", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsLoadingSkeleton, {
        copy: copyEn,
        presence: { stage: "muse-curating", live: false },
      }),
    );

    expect(html).toContain(copyEn.recLoading);
    expect(html).not.toContain(copyEn.recAgentTitle);
  });

  test("compact live state embeds the smaller presence in the compact footprint", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsLoadingSkeleton, {
        compact: true,
        copy: copyEn,
        presence: { stage: "finalizing", live: true },
      }),
    );

    expect(html).toContain(copyEn.recAgentTitle);
    expect(html).toContain(copyEn.recAgentFinalizing);
    expect(html).toContain("size-9");
  });

  test("distinguishes live Muse from deterministic outcomes", () => {
    // Deterministic/degraded runs pass live:false even with a stage set —
    // the UI must never brand them as Muse-curated.
    const deterministic = renderToStaticMarkup(
      createElement(ResultsLoadingSkeleton, {
        copy: copyEn,
        presence: { stage: null, live: false },
      }),
    );

    const degraded = renderToStaticMarkup(
      createElement(ResultsLoadingSkeleton, {
        copy: copyVi,
        presence: { stage: null, live: false },
      }),
    );

    for (const html of [deterministic, degraded]) {
      expect(html).not.toContain(copyEn.recAgentTitle);
      expect(html).not.toContain(copyVi.recAgentTitle);
    }

    expect(deterministic).toContain(copyEn.recLoading);
    expect(degraded).toContain(copyVi.recLoading);
  });
});
