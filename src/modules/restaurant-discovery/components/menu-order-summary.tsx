import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuSubtotal, menuSubtotal } from "@/modules/restaurant-discovery/menu-presentation";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { formatMoney } from "@/shared/money";

/**
 * Sticky order bar pinned inside the menu panel scroll container.
 *
 * Reuses the canonical `menuSubtotal`/`MenuSelection` contract verbatim: no
 * price math, no float sums, no independent quantities. Sticky (not fixed)
 * keeps its in-flow box, so it never covers the last menu item and never
 * floats across the map. Hidden at zero selections. Unknown or mixed
 * currencies reuse `copy.priceCheck` so the bar never shows a misleading
 * complete subtotal.
 */
export function MenuOrderSummary({
  menu,
  selections,
  locale,
  onViewOrder,
  reviewBlocked = false,
}: {
  readonly menu: InteractiveMenu;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly locale: string;
  readonly onViewOrder: () => void;
  readonly reviewBlocked?: boolean | undefined;
}) {
  const copy = menuCopy(locale);
  const quantity = selections.reduce((total, selection) => total + selection.quantity, 0);

  if (quantity === 0) return null;

  const subtotal = menuSubtotal(menu, selections);

  const summary = MenuSubtotal.$match(subtotal, {
    Empty: () => copy.empty,
    Unavailable: () => copy.priceCheck,
    Calculable: ({ amount, currency }) =>
      `${copy.subtotal}: ${formatMoney(amount, currency, locale)} ${currency}`,
  });

  return (
    <div className="sticky bottom-0 z-10 mt-4 rounded-2xl border-2 border-ink bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <output
          aria-live="polite"
          className="min-w-0 flex-1 text-sm font-bold break-words text-ink"
        >
          <span aria-hidden="true">🛍 </span>
          {copy.selected}: {quantity} · {summary}
        </output>
        <button
          type="button"
          onClick={onViewOrder}
          disabled={reviewBlocked}
          aria-describedby={reviewBlocked ? "menu-order-summary-review" : undefined}
          className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-ink px-5 text-sm font-bold whitespace-nowrap text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.show} <span aria-hidden="true">→</span>
        </button>
      </div>
      {reviewBlocked ? (
        <p
          id="menu-order-summary-review"
          className="mt-2 text-xs font-semibold break-words text-ink"
        >
          {copy.reviewRequired}
        </p>
      ) : null}
    </div>
  );
}
