import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import { SharedSelect } from "@/components/ui/select";
import {
  BusyStage,
  FlowAlert,
  FlowShell,
  type FlowProps,
} from "@/modules/muse-copilot/flows/conversation";
import { PriceUnavailable } from "@/modules/restaurant-discovery/components/currency-tools";
import { RestaurantMenuPanel } from "@/modules/restaurant-discovery/components/restaurant-menu-panel";
import { HINGLISH_STYLE, useMenuLanguage } from "@/modules/restaurant-discovery/menu-language";
import { presentReviewed } from "@/modules/restaurant-discovery/menu-presentation";
import { useMenuSelection } from "@/modules/restaurant-discovery/menu-selection-store";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type {
  CopilotDraftOrderInput,
  CopilotDraftOrderOutput,
} from "@/server/muse-copilot/copilot-schemas";
import { copilotDraftOrderFn } from "@/server/muse-copilot/copilot.functions";
import { currencyDigits, formatMoney, isCurrency } from "@/shared/money";

type MenuChannel = RestaurantSearch["channel"];

const CHANNELS: ReadonlyArray<MenuChannel> = ["dine_in", "takeaway", "delivery"];
const uuidSchema = z.uuid();

const copy = {
  en: {
    title: "Order with confidence",
    intro:
      "Pick from the venue's reviewed menu below, then let Muse price-check the draft. Nothing is added or removed until you tap it — every line needs your decision.",
    needsVenue: "Pick a place first (for example from Find) so there is a real menu to draft from.",
    channelLabel: "Sales channel",
    channelDineIn: "Dine-in",
    channelTakeaway: "Takeaway",
    channelDelivery: "Delivery",
    noteLabel: "Preferences for Muse (optional)",
    notePlaceholder: "e.g. lunch for two, one vegetarian",
    review: "Review with Muse",
    regenerate: "Review again",
    preparing: "Preparing your order draft…",
    draftFailed: "The draft did not finish. Try again when ready.",
    retry: "Try again",
    emptySelection: "Select items from the menu below first, then review them with Muse.",
    skippedLines: "lines cannot be drafted because they are not on the current menu.",
    draftNote: "Muse checked the lines below against the current menu.",
    incomplete: "Some lines could not be fully priced — confirm prices with the venue.",
    acceptAll: "Accept all",
    accepted: "Draft accepted — the waiter card in the menu panel below is ready to show.",
    accept: "Accept",
    remove: "Remove",
    dismiss: "Dismiss",
    lineUnavailable: "Price unavailable — confirm with the venue",
  },
  vi: {
    title: "Tự tin gọi món",
    intro:
      "Chọn món từ thực đơn đã duyệt của quán bên dưới, rồi để Muse kiểm giá bản soạn. Chưa có gì được thêm hay bớt cho đến khi bạn chạm — mỗi dòng đều cần bạn quyết.",
    needsVenue: "Hãy chọn quán trước (ví dụ từ Tìm món) để có thực đơn thật mà soạn.",
    channelLabel: "Kênh bán",
    channelDineIn: "Ăn tại chỗ",
    channelTakeaway: "Mang đi",
    channelDelivery: "Giao tận nơi",
    noteLabel: "Dặn thêm cho Muse (không bắt buộc)",
    notePlaceholder: "vd. bữa trưa cho hai người, một người ăn chay",
    review: "Nhờ Muse duyệt",
    regenerate: "Duyệt lại",
    preparing: "Đang soạn món gọi…",
    draftFailed: "Bản duyệt chưa xong. Thử lại khi bạn sẵn sàng.",
    retry: "Thử lại",
    emptySelection: "Hãy chọn món từ thực đơn bên dưới trước, rồi nhờ Muse duyệt.",
    skippedLines: "món không duyệt được vì không còn trong thực đơn hiện tại.",
    draftNote: "Muse đã kiểm các dòng bên dưới với thực đơn hiện tại.",
    incomplete: "Vài dòng chưa định giá đầy đủ — hãy xác nhận giá với quán.",
    acceptAll: "Chấp nhận tất cả",
    accepted: "Đã duyệt — thẻ phục vụ trong khung thực đơn bên dưới đã sẵn sàng để đưa ra.",
    accept: "Chấp nhận",
    remove: "Xóa",
    dismiss: "Bỏ",
    lineUnavailable: "Chưa có giá — hãy xác nhận với quán",
  },
} as const;

/** Display-only minor→major conversion for backend-computed totals. */
const formatMinor = (minor: string, currency: string, locale: string): string | null => {
  if (!isCurrency(currency)) {
    return null;
  }

  const digits = currencyDigits(currency);
  const padded = minor.padStart(digits + 1, "0");

  const major = digits === 0 ? padded : `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;

  return `${formatMoney(major, currency, locale)} ${currency}`;
};

const channelLabelFor = (
  channel: MenuChannel,
  strings: {
    readonly channelTakeaway: string;
    readonly channelDelivery: string;
    readonly channelDineIn: string;
  },
): string => {
  if (channel === "takeaway") {
    return strings.channelTakeaway;
  }

  if (channel === "delivery") {
    return strings.channelDelivery;
  }

  return strings.channelDineIn;
};

/**
 * Order flow. The venue's reviewed menu, selection state, subtotals, and
 * waiter card all stay inside the canonical `RestaurantMenuPanel` (same
 * `useMenuSelection` controller key, same `presentReviewed` projection —
 * the panel's TanStack query cache is shared, so no menu loads twice).
 * This flow only adds the Muse draft review: current selections travel as
 * the draft input items, and the backend's priced lines, warnings, and
 * completeness flag render for explicit per-line accept/remove. No price
 * math lives here — `formatMinor` only displays backend-computed totals.
 */
export default function OrderFlow({ context }: FlowProps): ReactNode {
  const strings = context.language === "vi" ? copy.vi : copy.en;

  if (context.venueId === undefined) {
    return (
      <FlowShell title={strings.title} intro={strings.intro}>
        <p className="text-sm leading-relaxed text-ink">{strings.needsVenue}</p>
      </FlowShell>
    );
  }

  return <OrderFlowBody contextVenueId={context.venueId} language={context.language} />;
}

function OrderFlowBody({
  contextVenueId,
  language,
}: {
  readonly contextVenueId: string;
  readonly language: "en" | "vi";
}): ReactNode {
  const strings = language === "vi" ? copy.vi : copy.en;
  const [channel, setChannel] = useState<MenuChannel>("dine_in");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<CopilotDraftOrderOutput | null>(null);
  const [pending, setPending] = useState<ReadonlyArray<string>>([]);
  const [accepted, setAccepted] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const runId = useRef(0);

  const controller = useMenuSelection(contextVenueId, channel);
  const { menuLang } = useMenuLanguage(language);
  const projectionLang = menuLang === HINGLISH_STYLE ? "en" : menuLang;

  const menuQuery = useQuery({
    queryKey: ["restaurant-menu", contextVenueId, channel],
    queryFn: () => getRestaurantFn({ data: { venueId: contextVenueId, channel } }),
    staleTime: 60000,
    retry: false,
  });

  const offerings = menuQuery.data?.offerings ?? [];
  const venueName = menuQuery.data?.venue?.name ?? null;

  const menu =
    menuQuery.isSuccess && offerings.length > 0
      ? presentReviewed(offerings, venueName, projectionLang)
      : null;

  const variantItems = new Map(
    (menu?.items ?? []).flatMap((item) =>
      item.variants.map((variant) => [variant.id, item.id] as const),
    ),
  );

  const changeChannel = (next: MenuChannel): void => {
    setChannel(next);
    setDraft(null);
    setPending([]);
    setAccepted(false);
    setDraftFailed(false);
  };

  const review = (): void => {
    const id = runId.current + 1;
    runId.current = id;

    const alive = (): boolean => runId.current === id;
    const venueId = uuidSchema.safeParse(contextVenueId).success ? contextVenueId : null;

    if (venueId === null) {
      setDraftFailed(true);

      return;
    }

    const items: Array<{ itemKey: string; variantKey?: string; qty: number }> = [];

    for (const selection of controller.selections) {
      const itemKey = variantItems.get(selection.variantId);

      if (
        itemKey === undefined ||
        !uuidSchema.safeParse(itemKey).success ||
        !uuidSchema.safeParse(selection.variantId).success
      ) {
        continue;
      }

      items.push({ itemKey, variantKey: selection.variantId, qty: selection.quantity });
    }

    if (items.length === 0) {
      return;
    }

    setPreparing(true);
    setDraftFailed(false);
    setAccepted(false);

    const trimmedNote = note.trim();

    const input: CopilotDraftOrderInput = { venueId, items };

    if (trimmedNote !== "") {
      input.instructions = trimmedNote;
    }

    void copilotDraftOrderFn({ data: input }).then(
      (output) => {
        if (!alive()) {
          return;
        }

        setDraft(output);
        setPending(output.lines.map((line) => line.itemKey));
        setPreparing(false);
        setDraftFailed(false);
      },
      () => {
        if (alive()) {
          setPreparing(false);
          setDraftFailed(true);
        }
      },
    );
  };

  const undraftable = controller.selections.filter(
    (selection) => variantItems.get(selection.variantId) === undefined,
  ).length;

  const removeSelection = (itemKey: string): void => {
    const variantIds = new Set(
      (menu?.items ?? [])
        .filter((item) => item.id === itemKey)
        .flatMap((item) => item.variants.map((variant) => variant.id)),
    );

    controller.setSelections((previous) =>
      previous.filter((selection) => !variantIds.has(selection.variantId)),
    );
    setPending((previous) => previous.filter((entry) => entry !== itemKey));
  };

  const acceptLine = (itemKey: string): void => {
    setPending((previous) => previous.filter((entry) => entry !== itemKey));

    if (pending.length <= 1) {
      setAccepted(true);
    }
  };

  const acceptAll = (): void => {
    setPending([]);
    setAccepted(true);
  };

  return (
    <FlowShell title={strings.title} intro={strings.intro}>
      <SharedSelect
        ariaLabel={strings.channelLabel}
        value={channel}
        onValueChange={(value) => {
          if (value === "dine_in" || value === "takeaway" || value === "delivery") {
            changeChannel(value);
          }
        }}
        options={CHANNELS.map((entry) => ({
          value: entry,
          label: channelLabelFor(entry, strings),
        }))}
        size="regular"
      />

      <RestaurantMenuPanel
        channel={channel}
        lang={language}
        onChannelChange={changeChannel}
        venueId={contextVenueId}
        venueName={venueName}
        countryCode={null}
      />

      <div className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="copilot-order-note" className="text-sm font-semibold text-ink">
            {strings.noteLabel}
          </label>

          <input
            id="copilot-order-note"
            type="text"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            placeholder={strings.notePlaceholder}
            autoComplete="off"
            className="min-h-11 w-full rounded-xl border border-border-soft bg-white px-4 text-base text-ink outline-none placeholder:text-muted focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          />
        </div>

        <button
          type="button"
          onClick={review}
          disabled={preparing || controller.selections.length === 0}
          className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {draft === null ? strings.review : strings.regenerate}
        </button>

        {controller.selections.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted">{strings.emptySelection}</p>
        ) : null}
      </div>

      <BusyStage stage={preparing ? strings.preparing : null} />

      {draftFailed ? (
        <FlowAlert message={strings.draftFailed} onRetry={review} retryLabel={strings.retry} />
      ) : null}

      {undraftable > 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          {undraftable} {strings.skippedLines}
        </p>
      ) : null}

      {draft === null ? null : (
        <div className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3">
          <p className="text-xs font-semibold text-muted">{strings.draftNote}</p>

          {draft.warnings.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
              {draft.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {draft.incomplete ? (
            <p className="text-sm font-semibold break-words text-ink">{strings.incomplete}</p>
          ) : null}

          <ul className="flex flex-col gap-2">
            {draft.lines
              .filter((line) => pending.includes(line.itemKey))
              .map((line) => {
                const rendered =
                  line.lineMinor !== null
                    ? formatMinor(line.lineMinor, draft.currency, language)
                    : null;

                return (
                  <li
                    key={line.itemKey}
                    className="flex flex-wrap items-center gap-2 rounded-xl bg-cream/60 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold break-words text-ink">
                        {line.qty} × {line.name}
                      </p>

                      {rendered === null ? (
                        <PriceUnavailable label={strings.lineUnavailable} />
                      ) : (
                        <p className="text-sm text-muted tabular-nums">{rendered}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        acceptLine(line.itemKey);
                      }}
                      className="inline-flex min-h-11 cursor-pointer items-center rounded-full bg-food-orange-strong px-4 text-sm font-bold text-white transition hover:bg-food-orange-dark"
                    >
                      {strings.accept}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        removeSelection(line.itemKey);
                      }}
                      className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-ink bg-white px-4 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
                    >
                      {strings.remove}
                    </button>
                  </li>
                );
              })}
          </ul>

          {pending.length > 1 ? (
            <button
              type="button"
              onClick={acceptAll}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
            >
              {strings.acceptAll}
            </button>
          ) : null}

          {accepted && pending.length === 0 ? (
            <p className="text-sm font-semibold text-ink">{strings.accepted}</p>
          ) : null}

          {draft.subtotalMinor !== null ? (
            <p className="text-sm font-bold text-ink tabular-nums">
              {formatMinor(draft.subtotalMinor, draft.currency, language)}
            </p>
          ) : null}
        </div>
      )}
    </FlowShell>
  );
}
