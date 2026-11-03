import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { researchCopyFor } from "@/components/research/research-copy";
import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type { CopilotContext, JourneyTask } from "@/modules/muse-copilot/journey/types";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Structured backend cards on white surfaces with dark text (galaxy theme:
 * cream workspace card, white content cards). Dish links use the canonical
 * dish route; restaurant links use the canonical map route
 * `/restaurants?venue=<uuid>&view=…` — never the legacy `/$venueId` page.
 * URLs ride only validated https citations; provider output never renders
 * as HTML. Dish cards carry Find-nearby and Order-help actions (real mode
 * switches preserving dish context); venue cards carry View + Open-menu.
 * Ratings, distances, hours, and photos are never shown — the card contract
 * carries none, and nothing here invents them.
 */
export function CopilotCards({
  cards,
  copy,
  language,
  onSelectTask,
  onUpdateContext,
}: {
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly copy: CopilotCopy;
  readonly language: "en" | "vi";
  readonly onSelectTask: (task: JourneyTask) => void;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}): ReactNode {
  if (cards.length === 0) {
    return null;
  }

  const researchCopy = researchCopyFor(language);

  const secondaryAction =
    "inline-flex min-h-11 items-center rounded-full border border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-food-orange-strong";

  return (
    <ul className="flex flex-col gap-3">
      {cards.map((card, index) => (
        <li
          key={`${card.kind}-${card.refId ?? card.url ?? index}`}
          className="rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_8px_20px_rgba(3,10,30,0.12)]"
        >
          {card.kind === "source" ? (
            <p className="mb-1 inline-flex items-center rounded-full bg-space-deep/10 px-2.5 py-0.5 text-[11px] font-bold tracking-wide text-muted uppercase">
              {researchCopy.webResultBadge}
            </p>
          ) : null}

          <h3 className="font-display text-xl leading-tight tracking-wide text-ink">
            {card.title}
          </h3>

          {card.summary === undefined || card.summary === "" ? null : (
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink">
              {card.summary}
            </p>
          )}

          {card.kind === "source" ? (
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {researchCopy.notVerifiedNote}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-2">
            {card.kind === "dish" && card.refId !== undefined ? (
              <Link
                to="/dishes/$dishId"
                params={{ dishId: card.refId }}
                search={{ lang: language }}
                onClick={() => {
                  onUpdateContext({ dishId: card.refId });
                }}
                className="inline-flex min-h-11 items-center rounded-full bg-food-orange-strong px-4 text-sm font-bold text-white transition hover:bg-food-orange-dark"
              >
                {copy.viewDishLabel}
              </Link>
            ) : null}

            {card.kind === "dish" && card.refId !== undefined ? (
              <button
                type="button"
                onClick={() => {
                  onUpdateContext({ dishId: card.refId });
                  onSelectTask("find");
                }}
                className={secondaryAction}
              >
                {copy.findNearbyLabel}
              </button>
            ) : null}

            {card.kind === "dish" && card.refId !== undefined ? (
              <button
                type="button"
                onClick={() => {
                  onUpdateContext({ dishId: card.refId });
                  onSelectTask("order");
                }}
                className={secondaryAction}
              >
                {copy.orderHelpLabel}
              </button>
            ) : null}

            {card.kind === "restaurant" &&
            card.refId !== undefined &&
            UUID_PATTERN.test(card.refId) ? (
              <Link
                to="/restaurants"
                search={{ lang: language, venue: card.refId, view: "overview" }}
                onClick={() => {
                  onUpdateContext({ venueId: card.refId });
                }}
                className="inline-flex min-h-11 items-center rounded-full bg-food-orange-strong px-4 text-sm font-bold text-white transition hover:bg-food-orange-dark"
              >
                {copy.viewVenueLabel}
              </Link>
            ) : null}

            {card.kind === "restaurant" &&
            card.refId !== undefined &&
            UUID_PATTERN.test(card.refId) ? (
              <Link
                to="/restaurants"
                search={{ lang: language, venue: card.refId, view: "menu" }}
                onClick={() => {
                  onUpdateContext({ venueId: card.refId });
                }}
                className={secondaryAction}
              >
                {copy.openMenuLabel}
              </Link>
            ) : null}

            {(card.kind === "price" || card.kind === "source") && card.url !== undefined ? (
              <a
                href={card.url}
                target="_blank"
                rel="noreferrer noopener"
                className={secondaryAction}
              >
                {card.title}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
