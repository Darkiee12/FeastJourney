import { Predicate } from "effect";
import { Globe2Icon, SparklesIcon, TriangleAlertIcon, UtensilsCrossedIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import { DishCarouselSkeleton } from "@/components/dish/dish-carousel";
import {
  MuseResearchStatus,
  type ResearchStatusState,
} from "@/components/research/muse-research-status";
import { researchCopyFor, type ResearchLanguage } from "@/components/research/research-copy";
import {
  ResearchFindingsList,
  type ResearchFinding,
  type ResearchSource,
} from "@/components/research/research-findings";
import { researchDishesFn } from "@/server/web-research/research-functions";
import type { Messages } from "@/shared/i18n";

/**
 * Result presentation shell for the homepage discovery carousel. Owns every
 * non-carousel state so the section never collapses to a bare paragraph:
 * loading reuses the shared skeleton, failures get a distinct error panel
 * with retry, and empty results get an illustrated panel sized to the
 * carousel footprint. The worldwide fallback itself stays a real
 * `DishCarousel` owned by the caller; this shell only contributes the small
 * subordinate note that keeps worldwide dishes from reading as local.
 *
 * New catalog copy this shell needs (see report): a worldwide-fallback note
 * and a catalog-empty tagline. Both arrive as optional props defaulting to
 * the approved English direction until `src/shared/i18n.ts` carries them.
 */

export const DISCOVERY_WORLDWIDE_NOTE_FALLBACK =
  "No dishes from this area in our catalog yet. Here are some favorites from around the world.";

export const DISCOVERY_CATALOG_TAGLINE_FALLBACK = "We're still collecting delicious discoveries.";

export type DiscoveryFallbackState =
  | "loading"
  | "error"
  | "unknown"
  | "region-empty"
  | "catalog-empty"
  | "ready";

export interface DiscoveryResultInput {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly located: boolean;
  readonly geoSettled: boolean;
  readonly total: number;
  readonly worldwide: boolean;
  readonly isAutoWorldwide: boolean;
}

/**
 * Pure state resolution for the discovery result area, shared by the shell
 * and the lead integrator. Mirrors the branch order in
 * `discovery-section.tsx`: loading wins, then failure, then any served
 * items, then the unlocated case, then catalog-empty (a worldwide scope
 * that still serves nothing) versus region-empty (a scoped query that
 * serves nothing while worldwide remains untried).
 */
export const resolveDiscoveryFallbackState = (
  input: DiscoveryResultInput,
): DiscoveryFallbackState => {
  if (input.loading) {
    return "loading";
  }

  if (input.failed) {
    return "error";
  }

  if (input.total > 0) {
    return "ready";
  }

  if (!input.located) {
    if (input.geoSettled) {
      return "unknown";
    }

    return "loading";
  }

  if (input.worldwide || input.isAutoWorldwide) {
    return "catalog-empty";
  }

  return "region-empty";
};

const PANEL_FRAME =
  "grid w-full place-items-center overflow-hidden rounded-3xl border border-border-soft bg-white px-6 py-12 shadow-[0_12px_28px_rgba(194,65,12,0.08)] sm:px-8";

const PANEL_BODY =
  "flex min-h-[20rem] w-full max-w-[36rem] flex-col items-center text-center md:min-h-[22rem]";

const MEDALLION = "flex size-16 items-center justify-center rounded-full bg-cream";

export function DiscoveryLoadingState({ copy }: { readonly copy: Messages }): ReactNode {
  return (
    <div>
      <output className="block text-base font-semibold text-muted">
        {copy.discoverLocalLoading}
      </output>
      <div className="mt-4">
        <DishCarouselSkeleton />
      </div>
    </div>
  );
}

export function DiscoveryWorldwideNote({
  copy,
  note,
}: {
  readonly copy: Messages;
  readonly note?: string | undefined;
}): ReactNode {
  return (
    <p className="mb-4 flex items-start gap-2 text-sm font-semibold text-muted">
      <Globe2Icon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
      <span>
        <span className="font-bold text-ink">{copy.carouselWorldwide}</span>
        <span aria-hidden="true"> · </span>
        {note ?? DISCOVERY_WORLDWIDE_NOTE_FALLBACK}
      </span>
    </p>
  );
}

export function DiscoveryErrorPanel({
  copy,
  onRetry,
}: {
  readonly copy: Messages;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div role="alert" className={PANEL_FRAME}>
      <div className={PANEL_BODY}>
        <span className={`${MEDALLION} bg-danger/10`}>
          <TriangleAlertIcon aria-hidden="true" className="size-8 text-danger" />
        </span>
        <p className="mt-5 text-lg font-bold text-ink">{copy.discoverLocalError}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex min-h-11 cursor-pointer items-center rounded-full bg-food-orange-strong px-6 text-sm font-bold text-white transition hover:bg-food-orange-dark"
        >
          {copy.commonRetry}
        </button>
      </div>
    </div>
  );
}

export function DiscoveryUnknownPanel({ copy }: { readonly copy: Messages }): ReactNode {
  return (
    <div className={PANEL_FRAME}>
      <div className={PANEL_BODY}>
        <span className={MEDALLION}>
          <Globe2Icon aria-hidden="true" className="size-8 text-food-orange-strong" />
        </span>
        <p className="mt-5 text-lg font-bold text-ink">{copy.discoverLocalUnknown}</p>
      </div>
    </div>
  );
}

export function DiscoveryRegionEmptyPanel({
  copy,
  onExploreWorldwide,
  researchSlot,
}: {
  readonly copy: Messages;
  readonly onExploreWorldwide: () => void;
  /** User-triggered web-research flow; shown only after the catalog gate stays empty. */
  readonly researchSlot?: ReactNode | undefined;
}): ReactNode {
  return (
    <div className={PANEL_FRAME}>
      <div className={PANEL_BODY}>
        <span className={MEDALLION}>
          <UtensilsCrossedIcon aria-hidden="true" className="size-8 text-food-orange-strong" />
        </span>
        <p className="mt-5 text-lg font-bold text-ink">{copy.carouselRegionEmpty}</p>
        <p className="mt-2 text-sm font-semibold text-muted">{copy.carouselWorldwide}</p>
        <button
          type="button"
          onClick={onExploreWorldwide}
          className="mt-6 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
        >
          <Globe2Icon aria-hidden="true" className="size-4 flex-none" />
          {copy.carouselExploreWorld}
        </button>
        {researchSlot}
      </div>
    </div>
  );
}

export function DiscoveryCatalogEmptyPanel({
  copy,
  researchSlot,
  tagline,
}: {
  readonly copy: Messages;
  /** User-triggered web-research flow; shown only after the catalog gate stays empty. */
  readonly researchSlot?: ReactNode | undefined;
  readonly tagline?: string | undefined;
}): ReactNode {
  return (
    <div className={PANEL_FRAME}>
      <div className={PANEL_BODY}>
        <span className={MEDALLION}>
          <UtensilsCrossedIcon aria-hidden="true" className="size-8 text-food-orange-strong" />
        </span>
        <p className="mt-5 text-lg font-bold text-ink">{copy.discoverLocalEmpty}</p>
        <p className="mt-2 text-sm font-semibold text-muted">
          {tagline ?? DISCOVERY_CATALOG_TAGLINE_FALLBACK}
        </p>
        {researchSlot}
      </div>
    </div>
  );
}

/**
 * Boundary schemas for the peer-owned `researchDishesFn` TanStack server
 * function (src/server/web-research/research-functions.ts). Input carries the
 * city/country the catalog already proved empty plus the research language;
 * the JSON outcome always carries a `_tag` discriminator. Zod parses the
 * outcome at this boundary because web-derived claims cross a trust boundary;
 * malformed payloads fail closed to the `failed` state, never to invented
 * findings.
 */
const researchSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});

const researchFindingSchema = z.object({
  title: z.string(),
  summary: z.string(),
  venueName: z.string().optional(),
  dishName: z.string().optional(),
  originalName: z.string().optional(),
  sources: z.array(researchSourceSchema),
});

const researchOutcomeSchema = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("ResearchFound"), findings: z.array(researchFindingSchema) }),
  z.object({ _tag: z.literal("ResearchEmpty") }),
  z.object({ _tag: z.literal("ResearchSkipped") }),
  z.object({ _tag: z.literal("ResearchUnavailable") }),
]);

type ResearchOutcome = z.infer<typeof researchOutcomeSchema>;

/**
 * Peer-owned server function. The server validator owns the request shape
 * and `researchOutcomeSchema` re-validates every payload at the call site,
 * so a drifted peer shape fails closed instead of rendering untrusted data.
 */
const runResearch = async (
  args: Parameters<typeof researchDishesFn>[0],
): Promise<ResearchOutcome | null> => {
  const parsed = researchOutcomeSchema.safeParse(await researchDishesFn(args));

  return parsed.success ? parsed.data : null;
};

/** Renderable only over http(s); rejects javascript:, data:, and malformed URLs. */
const isHttpUrl = (raw: string): boolean => {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:";
};

/**
 * Findings worth rendering: `ResearchFound` with at least one finding that
 * carries usable text and linkable sources. Every other outcome —
 * `ResearchEmpty`, `ResearchSkipped`, `ResearchUnavailable` — yields no
 * renderable findings so the caller lands on its no-evidence state.
 */
const toUsableFindings = (outcome: ResearchOutcome): ReadonlyArray<ResearchFinding> => {
  if (!Predicate.isTagged(outcome, "ResearchFound")) {
    return [];
  }

  const usable: Array<ResearchFinding> = [];

  for (const finding of outcome.findings) {
    const title = finding.title.trim();
    const summary = finding.summary.trim();

    if (title === "" || summary === "") {
      continue;
    }

    const sources: Array<ResearchSource> = [];

    for (const source of finding.sources) {
      const sourceTitle = source.title.trim();

      if (sourceTitle === "" || !isHttpUrl(source.url)) {
        continue;
      }

      sources.push({ title: sourceTitle, url: source.url, snippet: source.snippet });
    }

    if (sources.length === 0) {
      continue;
    }

    const venueName = finding.venueName?.trim() ?? "";
    const dishName = finding.dishName?.trim() ?? "";
    const originalName = finding.originalName?.trim() ?? "";

    usable.push({
      title,
      summary,
      sources,
      venueName: venueName === "" ? undefined : venueName,
      dishName: dishName === "" ? undefined : dishName,
      originalName: originalName === "" ? undefined : originalName,
    });
  }

  return usable;
};

export interface DiscoveryResearchSlotProps {
  /** City or region display label the catalog already proved empty. */
  readonly city: string;
  /** Country display name the catalog already proved empty. */
  readonly country: string;
  readonly language: ResearchLanguage;
  /** Returns to the worldwide catalog; wired to the existing explore-worldwide action. */
  readonly onContinueWorldwide?: (() => void) | undefined;
}

/**
 * User-triggered web-research flow for empty discovery results. Never
 * auto-fires: the slot renders a single opt-in button while `idle`, and only
 * the click starts the preparing → searching → reviewing → terminal
 * sequence against `researchDishesFn`. Findings render through
 * `ResearchFindingsList`, kept strictly separate from the canonical
 * `DishCarousel` (web rows never become catalog dish IDs). An in-flight run
 * is abandoned on unmount via a request generation counter.
 */
export function DiscoveryResearchSlot({
  city,
  country,
  language,
  onContinueWorldwide,
}: DiscoveryResearchSlotProps): ReactNode {
  const copy = researchCopyFor(language);
  const [phase, setPhase] = useState<ResearchStatusState>("idle");
  const [findings, setFindings] = useState<ReadonlyArray<ResearchFinding>>([]);
  const requestRef = useRef(0);

  useEffect(() => {
    return () => {
      requestRef.current += 1;
    };
  }, []);

  const run = (): void => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setPhase("preparing");
    setFindings([]);

    const trimmedCity = city.trim();
    const trimmedCountry = country.trim();

    if (trimmedCity === "" || trimmedCountry === "") {
      setPhase("failed");

      return;
    }

    // Searching starts only once the fetch below is actually issued — the
    // database-first gate (this slot mounts only on catalog-empty states)
    // already ran before any network research begins.
    setPhase("searching");

    void (async () => {
      let outcome: ResearchOutcome | null = null;

      try {
        outcome = await runResearch({
          data: { city: trimmedCity, country: trimmedCountry, language },
        });
      } catch {
        outcome = null;
      }

      if (requestRef.current !== request) {
        return;
      }

      if (outcome === null) {
        setPhase("failed");

        return;
      }

      setPhase("reviewing");
      const usable = toUsableFindings(outcome);

      if (requestRef.current !== request) {
        return;
      }

      if (usable.length === 0) {
        setPhase("no-evidence");

        return;
      }

      setFindings(usable);
      setPhase("completed");
    })();
  };

  if (phase === "idle") {
    return (
      <div className="mt-6 flex w-full flex-col items-center gap-3 border-t border-border-soft pt-6">
        <button
          type="button"
          onClick={run}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
        >
          <SparklesIcon aria-hidden="true" className="size-4 flex-none" />
          {copy.researchAction}
        </button>
        <p className="max-w-[32rem] text-xs font-semibold text-muted">{copy.beyondCatalogNote}</p>
        <p className="text-xs font-bold tracking-[0.14em] text-muted uppercase">
          {copy.researchingDishes}
          {" · "}
          {copy.researchingRestaurants}
          {" · "}
          {copy.researchingPrices}
        </p>
      </div>
    );
  }

  let contextLine = copy.statusTitle;

  if (phase === "preparing" || phase === "searching") {
    contextLine = copy.statusSearching;
  } else if (phase === "reviewing") {
    contextLine = copy.statusReviewing;
  } else if (phase === "completed") {
    contextLine = copy.statusCompleted;
  } else if (phase === "no-evidence") {
    contextLine = copy.statusNoEvidence;
  } else {
    contextLine = copy.statusFailed;
  }

  let continueHandler: (() => void) | undefined;

  if (phase === "failed" || phase === "no-evidence") {
    continueHandler = onContinueWorldwide;
  }

  return (
    <div className="mt-6 w-full border-t border-border-soft pt-6">
      <MuseResearchStatus
        state={phase}
        contextLine={contextLine}
        onRetry={phase === "failed" ? run : undefined}
        onContinue={continueHandler}
        retryLabel={copy.retryAction}
        continueLabel={copy.continueCatalogAction}
      />
      {phase === "completed" ? (
        <ResearchFindingsList
          findings={findings}
          badgeLabel={copy.webResultBadge}
          notVerifiedNote={copy.notVerifiedNote}
        />
      ) : null}
    </div>
  );
}

export interface DiscoveryFallbackProps {
  readonly copy: Messages;
  readonly state: DiscoveryFallbackState;
  /** Retry handler for the error panel; required when state is "error". */
  readonly onRetry?: (() => void) | undefined;
  /** Worldwide handler for the region-empty panel; required when state is "region-empty". */
  readonly onExploreWorldwide?: (() => void) | undefined;
  /** Overrides the default worldwide-fallback note (unused by the panels). */
  readonly worldwideNote?: string | undefined;
  /** Overrides the default catalog-empty tagline. */
  readonly emptyTagline?: string | undefined;
  /** User-triggered web-research flow for empty states; the panels render it below their actions. */
  readonly researchSlot?: ReactNode | undefined;
}

/**
 * Switch mounting one fallback panel per non-ready state. The "ready" and
 * "loading" states render nothing here: the caller owns the carousel (plus
 * `DiscoveryWorldwideNote` above it for worldwide scopes) and renders
 * `DiscoveryLoadingState` for loading so the skeleton keeps its announced
 * loading region.
 */
export function DiscoveryFallback({
  copy,
  emptyTagline,
  onExploreWorldwide,
  onRetry,
  researchSlot,
  state,
}: DiscoveryFallbackProps): ReactNode {
  if (state === "loading" || state === "ready") {
    return null;
  }

  if (state === "error") {
    if (onRetry === undefined) {
      return null;
    }

    return <DiscoveryErrorPanel copy={copy} onRetry={onRetry} />;
  }

  if (state === "unknown") {
    return <DiscoveryUnknownPanel copy={copy} />;
  }

  if (state === "region-empty") {
    if (onExploreWorldwide === undefined) {
      return null;
    }

    return (
      <DiscoveryRegionEmptyPanel
        copy={copy}
        onExploreWorldwide={onExploreWorldwide}
        researchSlot={researchSlot}
      />
    );
  }

  return (
    <DiscoveryCatalogEmptyPanel copy={copy} tagline={emptyTagline} researchSlot={researchSlot} />
  );
}
