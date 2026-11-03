import { Match } from "effect";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";
import { formatReviewDate } from "@/modules/restaurant-discovery/components/restaurant-review-card";
import {
  reviewHighlightsFn,
  supportingReviewsFn,
} from "@/server/review-intelligence/review-intelligence.functions";

/**
 * Props for the traveler-review highlights strip. Language is restricted to
 * the locales with reviewed UI copy; anything else renders English upstream.
 */
export interface MuseReviewHighlightsProps {
  readonly venueId: string;
  readonly language: "en" | "vi";
}

/**
 * Tolerant client boundary over the peer outcome: unknown extra members are
 * stripped, malformed payloads degrade to the failed state. The server
 * already validates; this guards transport drift the same way the research
 * panel validates its peer-typed results.
 */
const highlightsEvidenceSchema = z.object({
  reviewId: z.string(),
  snippet: z.string(),
});

const highlightsOutcomeSchema = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("Ready"),
    overview: z.string(),
    positives: z.array(z.string()),
    cautions: z.array(z.string()),
    evidence: z.array(highlightsEvidenceSchema),
    sampleCount: z.number(),
    totalCount: z.number(),
    generatedAt: z.string(),
  }),
  z.object({ _tag: z.literal("Insufficient") }),
  z.object({ _tag: z.literal("Unavailable") }),
]);

type HighlightsOutcome = z.infer<typeof highlightsOutcomeSchema>;

type HighlightsReady = Extract<HighlightsOutcome, { _tag: "Ready" }>;

const supportingReviewSchema = z.object({
  id: z.string(),
  rating: z.number().optional(),
  body: z.string().min(1),
});

const supportingOutcomeSchema = z.union([
  z.array(supportingReviewSchema),
  z.object({ items: z.array(supportingReviewSchema) }),
]);

type SupportingReview = z.infer<typeof supportingReviewSchema>;

type HighlightsPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly outcome: HighlightsReady }
  | { readonly kind: "hidden" }
  | { readonly kind: "failed" };

function scrollToReview(reviewId: string): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const target = document.getElementById(`review-${reviewId}`);

  if (target === null) {
    return;
  }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
}

function peerOutcome(result: HighlightsOutcome): HighlightsPhase {
  return Match.value(result).pipe(
    Match.tag("Ready", (ready): HighlightsPhase => ({ kind: "ready", outcome: ready })),
    Match.tag("Insufficient", (): HighlightsPhase => ({ kind: "hidden" })),
    Match.tag("Unavailable", (): HighlightsPhase => ({ kind: "failed" })),
    Match.exhaustive,
  );
}

/**
 * Inline AI summary of this venue's own published reviews. Non-blocking: it
 * loads beside the review list and never delays it. Absence (Insufficient
 * data, failure, or the peer contract failing at runtime) hides the section
 * and keeps the reviews; failures offer a retry. Copy never claims web
 * research — this only summarizes traveler reviews already shown below.
 */
export function MuseReviewHighlights({ venueId, language }: MuseReviewHighlightsProps) {
  const [attempt, setAttempt] = useState(0);

  return (
    <MuseReviewHighlightsBody
      key={`${venueId}:${language}:${attempt}`}
      venueId={venueId}
      language={language}
      onRetry={() => {
        setAttempt((previous) => previous + 1);
      }}
    />
  );
}

function MuseReviewHighlightsBody({
  venueId,
  language,
  onRetry,
}: {
  readonly venueId: string;
  readonly language: "en" | "vi";
  readonly onRetry: () => void;
}) {
  const copy: RestaurantCopy = restaurantCopy(language);

  const [phase, setPhase] = useState<HighlightsPhase>({ kind: "loading" });
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<ReadonlyArray<SupportingReview> | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  // Key-remount (see above) owns the loading reset: fresh venue, language,
  // or retry starts from loading with no synchronous setState in this effect.
  useEffect(() => {
    let cancelled = false;

    void reviewHighlightsFn({ data: { venueId, language } })
      .then((result) => {
        if (cancelled) {
          return;
        }

        const parsed = highlightsOutcomeSchema.safeParse(result);

        if (!parsed.success) {
          setPhase({ kind: "failed" });

          return;
        }

        setPhase(peerOutcome(parsed.data));
      })
      .catch(() => {
        if (!cancelled) {
          setPhase({ kind: "failed" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [venueId, language]);

  const loadEvidence = (ids: ReadonlyArray<string>): void => {
    if (evidenceBusy) {
      return;
    }

    setEvidenceBusy(true);

    void supportingReviewsFn({ data: { ids: [...ids] } })
      .then((result) => {
        const parsed = supportingOutcomeSchema.safeParse(result);

        let rows: ReadonlyArray<SupportingReview> = [];

        if (parsed.success) {
          if (Array.isArray(parsed.data)) {
            rows = parsed.data;
          } else {
            rows = parsed.data.items;
          }
        }

        setEvidence(rows);
        setEvidenceOpen(true);
      })
      .catch(() => {
        setEvidence([]);
        setEvidenceOpen(true);
      })
      .finally(() => {
        setEvidenceBusy(false);
      });
  };

  if (phase.kind === "hidden") {
    return null;
  }

  if (phase.kind === "loading") {
    return (
      <section className="reviews-highlights" aria-busy="true" aria-label={copy.reviewsAiLoading}>
        <p className="reviews-highlights-loading">
          <MessageSquare aria-hidden="true" />
          {copy.reviewsAiLoading}
        </p>
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-line" />
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-line" />
      </section>
    );
  }

  if (phase.kind === "failed") {
    return (
      <section className="reviews-highlights" aria-label={copy.reviewsAiTitle}>
        <p className="reviews-highlights-unavailable">{copy.reviewsAiUnavailable}</p>
        <button type="button" className="reviews-ghost" onClick={onRetry}>
          {copy.reviewsAiRetry}
        </button>
      </section>
    );
  }

  const outcome = phase.outcome;
  const evidenceIds = outcome.evidence.map((entry) => entry.reviewId);

  const evidenceById: ReadonlyMap<string, SupportingReview> = new Map(
    (evidence ?? []).map((entry) => [entry.id, entry] as const),
  );

  return (
    <section className="reviews-highlights" aria-label={copy.reviewsAiTitle}>
      <h3>
        <MessageSquare aria-hidden="true" />
        {copy.reviewsAiTitle}
      </h3>
      <p className="reviews-highlights-overview">{outcome.overview}</p>
      {outcome.positives.length > 0 ? (
        <div className="reviews-highlights-group">
          <h4>{copy.reviewsAiPositives}</h4>
          <ul>
            {outcome.positives.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {outcome.cautions.length > 0 ? (
        <div className="reviews-highlights-group">
          <h4>{copy.reviewsAiCautions}</h4>
          <ul>
            {outcome.cautions.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="reviews-highlights-sample">
        {copy.reviewsAiSample
          .replace("{sample}", String(outcome.sampleCount))
          .replace("{total}", String(outcome.totalCount))}
        {" · "}
        {formatReviewDate(outcome.generatedAt, language)}
      </p>
      {evidenceIds.length > 0 ? (
        <div className="reviews-highlights-evidence">
          <button
            type="button"
            className="reviews-ghost"
            aria-expanded={evidenceOpen}
            aria-busy={evidenceBusy}
            disabled={evidenceBusy}
            onClick={() => {
              if (evidenceOpen) {
                setEvidenceOpen(false);

                return;
              }

              if (evidence !== null) {
                setEvidenceOpen(true);

                return;
              }

              loadEvidence(evidenceIds);
            }}
          >
            <ArrowUpRight aria-hidden="true" />
            {evidenceOpen ? copy.reviewsAiHideEvidence : copy.reviewsAiReadEvidence}
          </button>
          {evidenceOpen ? (
            <ul className="reviews-evidence-list">
              {outcome.evidence.map((entry) => {
                const full = evidenceById.get(entry.reviewId);

                return (
                  <li key={entry.reviewId} className="reviews-evidence-item">
                    <blockquote>{full?.body ?? entry.snippet}</blockquote>
                    <button
                      type="button"
                      className="reviews-link"
                      onClick={() => {
                        scrollToReview(entry.reviewId);
                      }}
                    >
                      {copy.reviewsAiJumpToReview}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
