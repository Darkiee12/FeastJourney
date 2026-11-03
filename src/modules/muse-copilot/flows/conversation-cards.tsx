import { Link } from "@tanstack/react-router";
import { Banknote, ExternalLink, MapPin, UtensilsCrossed, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { researchCopyFor } from "@/components/research/research-copy";
import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import { MuseAction, type CopilotContext } from "@/modules/muse-copilot/journey/types";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";
import type { Locale } from "@/shared/i18n";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CARD_SHELL =
  "min-w-0 rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_1px_2px_rgba(3,10,30,0.08)]";

const PRIMARY_ACTION =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full bg-food-orange-strong px-4 text-sm font-bold text-white transition hover:bg-food-orange-dark";

const SECONDARY_ACTION =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-food-orange-strong";

function KindMark({ icon: Icon }: { readonly icon: LucideIcon }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 flex-none items-center justify-center rounded-full bg-space-deep text-mango"
    >
      <Icon className="size-4" />
    </span>
  );
}

function DishCard({
  card,
  copy,
  language,
  onAction,
  onUpdateContext,
}: {
  readonly card: CopilotCard;
  readonly copy: CopilotCopy;
  readonly language: Locale;
  readonly onAction: (action: MuseAction) => void;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}): ReactNode {
  return (
    <li className={CARD_SHELL}>
      <div className="flex items-start gap-2.5">
        <KindMark icon={UtensilsCrossed} />

        <h3 className="min-w-0 flex-1 font-display text-xl leading-tight tracking-wide break-words text-ink">
          {card.title}
        </h3>
      </div>

      {card.summary === undefined || card.summary === "" ? null : (
        <p className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
          {card.summary}
        </p>
      )}

      {card.refId === undefined ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Link
            to="/dishes/$dishId"
            params={{ dishId: card.refId }}
            search={{ lang: language }}
            onClick={() => {
              onUpdateContext({ dishId: card.refId });
            }}
            className={PRIMARY_ACTION}
          >
            <UtensilsCrossed aria-hidden="true" className="size-4" />
            {copy.viewDishLabel}
          </Link>

          <button
            type="button"
            onClick={() => {
              onAction(MuseAction.FindRestaurants({ dishId: card.refId }));
            }}
            className={SECONDARY_ACTION}
          >
            <MapPin aria-hidden="true" className="size-4" />
            {copy.findNearbyLabel}
          </button>

          <button
            type="button"
            onClick={() => {
              onAction(MuseAction.OpenOrder({}));
            }}
            className={SECONDARY_ACTION}
          >
            {copy.orderHelpLabel}
          </button>
        </div>
      )}
    </li>
  );
}

function VenueCard({
  card,
  copy,
  language,
  onUpdateContext,
}: {
  readonly card: CopilotCard;
  readonly copy: CopilotCopy;
  readonly language: Locale;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}): ReactNode {
  const venueId = card.refId !== undefined && UUID_PATTERN.test(card.refId) ? card.refId : null;

  return (
    <li className={CARD_SHELL}>
      <div className="flex items-start gap-2.5">
        <KindMark icon={MapPin} />

        <h3 className="min-w-0 flex-1 font-display text-xl leading-tight tracking-wide break-words text-ink">
          {card.title}
        </h3>
      </div>

      {card.summary === undefined || card.summary === "" ? null : (
        <p className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
          {card.summary}
        </p>
      )}

      {venueId === null ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Link
            to="/restaurants"
            search={{ lang: language, venue: venueId, view: "overview" }}
            onClick={() => {
              onUpdateContext({ venueId });
            }}
            className={PRIMARY_ACTION}
          >
            <MapPin aria-hidden="true" className="size-4" />
            {copy.viewVenueLabel}
          </Link>

          <Link
            to="/restaurants"
            search={{ lang: language, venue: venueId, view: "menu" }}
            onClick={() => {
              onUpdateContext({ venueId });
            }}
            className={SECONDARY_ACTION}
          >
            {copy.openMenuLabel}
          </Link>
        </div>
      )}
    </li>
  );
}

function PriceCard({
  card,
  copy,
  language,
  onUpdateContext,
}: {
  readonly card: CopilotCard;
  readonly copy: CopilotCopy;
  readonly language: Locale;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}): ReactNode {
  const venueId = card.refId !== undefined && UUID_PATTERN.test(card.refId) ? card.refId : null;

  return (
    <li className={CARD_SHELL}>
      <div className="flex items-start gap-2.5">
        <KindMark icon={Banknote} />

        <p className="min-w-0 flex-1 text-base font-extrabold break-words text-ink tabular-nums">
          {card.title}
        </p>
      </div>

      {card.summary === undefined || card.summary === "" ? null : (
        <p className="mt-1.5 text-xs leading-relaxed break-words text-muted">{card.summary}</p>
      )}

      {venueId === null ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Link
            to="/restaurants"
            search={{ lang: language, venue: venueId, view: "menu" }}
            onClick={() => {
              onUpdateContext({ venueId });
            }}
            className={SECONDARY_ACTION}
          >
            <MapPin aria-hidden="true" className="size-4" />
            {copy.viewVenueLabel}
          </Link>
        </div>
      )}
    </li>
  );
}

function SourceCard({
  card,
  research,
}: {
  readonly card: CopilotCard;
  readonly research: { readonly badge: string; readonly note: string };
}): ReactNode {
  return (
    <li className={CARD_SHELL}>
      <p className="mb-1.5 inline-flex items-center self-start rounded-full bg-space-deep/10 px-2.5 py-0.5 text-[11px] font-bold tracking-wide text-muted uppercase">
        {research.badge}
      </p>

      <div className="flex items-start gap-2.5">
        <KindMark icon={ExternalLink} />

        <h3 className="min-w-0 flex-1 font-display text-xl leading-tight tracking-wide break-words text-ink">
          {card.title}
        </h3>
      </div>

      {card.summary === undefined || card.summary === "" ? null : (
        <p className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
          {card.summary}
        </p>
      )}

      <p className="mt-1 text-xs leading-relaxed text-muted">{research.note}</p>

      {card.url === undefined ? null : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <a href={card.url} target="_blank" rel="noreferrer noopener" className={SECONDARY_ACTION}>
            <ExternalLink aria-hidden="true" className="size-4" />
            {card.title}
          </a>
        </div>
      )}
    </li>
  );
}

/**
 * Structured backend cards on white surfaces with dark text (galaxy theme:
 * cream workspace card, white content cards). Each card kind renders its
 * own chrome — dish, venue, price, and research-citation are never one
 * generic container. Dish links use the canonical dish route; restaurant
 * and price-venue links use the canonical map route
 * `/restaurants?venue=<uuid>&view=…` — never the legacy `/$venueId` page.
 * URLs ride only validated https citations; provider output never renders
 * as HTML. Dish cards carry Find-nearby and Order-help buttons dispatching
 * typed `MuseAction` outcomes through `onAction`; venue cards carry View +
 * Open-menu. Ratings, distances, hours, and photos are never shown — the
 * card contract carries none, and nothing here invents them.
 */
export function CopilotCards({
  cards,
  copy,
  language,
  onAction,
  onUpdateContext,
}: {
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly copy: CopilotCopy;
  readonly language: Locale;
  readonly onAction: (action: MuseAction) => void;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}): ReactNode {
  if (cards.length === 0) {
    return null;
  }

  const researchCopy = researchCopyFor(language);

  return (
    <ul className="flex min-w-0 flex-col gap-2.5">
      {cards.map((card, index) => {
        if (card.kind === "dish") {
          return (
            <DishCard
              key={card.refId ?? `dish-${index.toString()}`}
              card={card}
              copy={copy}
              language={language}
              onAction={onAction}
              onUpdateContext={onUpdateContext}
            />
          );
        }

        if (card.kind === "restaurant") {
          return (
            <VenueCard
              key={card.refId ?? `venue-${index.toString()}`}
              card={card}
              copy={copy}
              language={language}
              onUpdateContext={onUpdateContext}
            />
          );
        }

        if (card.kind === "price") {
          return (
            <PriceCard
              key={card.refId ?? `price-${index.toString()}`}
              card={card}
              copy={copy}
              language={language}
              onUpdateContext={onUpdateContext}
            />
          );
        }

        return (
          <SourceCard
            key={card.url ?? `source-${index.toString()}`}
            card={card}
            research={{ badge: researchCopy.webResultBadge, note: researchCopy.notVerifiedNote }}
          />
        );
      })}
    </ul>
  );
}
