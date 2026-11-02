import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  exchangeRatesFn,
  supportedCurrenciesFn,
} from "@/modules/restaurant-discovery/restaurant.functions";
import { currencyPreferenceFn, saveCurrencyPreferenceFn } from "@/modules/user/currency.functions";
import { convertAmount, formatMoney, isAmount, isCurrency } from "@/shared/money";
import type { ExchangeRate } from "@/shared/money";

const rootRoute = getRouteApi("__root__");

export const currencyPreferenceKey = (userId: string) => ["currency-preference", userId];

const currencyStorageKey = (userId: string | null) =>
  userId === null ? "feastjourney.currency" : `feastjourney.currency:${userId}`;

const localCurrency = (userId: string | null) => {
  try {
    const saved = localStorage.getItem(currencyStorageKey(userId));

    return saved !== null && isCurrency(saved) ? saved : "";
  } catch {
    return "";
  }
};

const subscribeToCurrency = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("feastjourney-currency", notify);

  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("feastjourney-currency", notify);
  };
};

export function usePreferredCurrency() {
  const client = useQueryClient();
  const { session } = rootRoute.useRouteContext();
  const userId = session.status === "signed-in" ? session.user.id : null;

  const local = useSyncExternalStore(
    subscribeToCurrency,
    () => localCurrency(userId),
    () => "",
  );

  const [choice, setChoice] = useState<{ owner: string | null; currency: string }>();
  const [storageError, setStorageError] = useState(false);
  // A currency change made before the account-preference query resolved must
  // still reach the server once ownership is confirmed. Never flush across
  // accounts: the pending entry is dropped when it names another owner.
  const pendingSave = useRef<{ owner: string; code: string } | null>(null);

  const account = useQuery({
    queryKey: currencyPreferenceKey(userId ?? "signed-out"),
    queryFn: () => currencyPreferenceFn(),
    enabled: userId !== null,
    staleTime: 60000,
    retry: false,
  });

  const supported = useQuery({
    queryKey: ["supported-currencies"],
    queryFn: () => supportedCurrenciesFn(),
    staleTime: 86400000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: (input: { currency: string | null; userId: string }) =>
      saveCurrencyPreferenceFn({
        data: { currency: input.currency, expectedUserId: input.userId },
      }),
    onSuccess: (_result, saved) =>
      client.invalidateQueries({ queryKey: currencyPreferenceKey(saved.userId) }),
  });

  let currency = local;

  if (userId !== null && account.status === "success" && account.data.userId === userId) {
    currency = account.data.currency ?? "";
  }

  if (choice?.owner === userId) currency = choice.currency;

  useEffect(() => {
    const pending = pendingSave.current;

    if (pending === null || userId === null || pending.owner !== userId) {
      pendingSave.current = null;

      return;
    }

    if (account.status === "success" && account.data.userId === userId && !save.isPending) {
      pendingSave.current = null;
      save.mutate({ currency: pending.code === "" ? null : pending.code, userId });
    }
  });

  return {
    currency,
    codes: supported.data ?? [],
    loading: supported.isPending,
    unavailable: supported.isError,
    storageError,
    saving: save.isPending,
    error: save.isError || account.isError,
    change: (code: string) => {
      setChoice({ owner: userId, currency: code });

      try {
        localStorage.setItem(currencyStorageKey(userId), code);
        window.dispatchEvent(new Event("feastjourney-currency"));
      } catch {
        setStorageError(true);
      }

      if (userId !== null && account.status === "success" && account.data.userId === userId)
        save.mutate({ currency: code === "" ? null : code, userId });
      else if (userId !== null) pendingSave.current = { owner: userId, code };
    },
  };
}

export function CurrencySelector({
  preference,
}: {
  preference: ReturnType<typeof usePreferredCurrency>;
}) {
  return (
    <div className="currency-selector">
      <label htmlFor="preferred-currency">Show approximate equivalents in</label>
      <select
        id="preferred-currency"
        value={preference.currency}
        onChange={(event) => preference.change(event.target.value)}
        disabled={preference.saving}
      >
        <option value="">Original currencies only</option>
        {preference.currency !== "" && !preference.codes.includes(preference.currency) && (
          <option value={preference.currency}>{preference.currency}</option>
        )}
        {preference.codes.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      {preference.loading && <small aria-live="polite">Loading currency choices…</small>}
      {preference.unavailable && (
        <small aria-live="polite">
          Currency choices are temporarily unavailable. Original prices are still shown.
        </small>
      )}
      {preference.saving && <small aria-live="polite">Saving account preference…</small>}
      {preference.error && (
        <small aria-live="polite">
          Account currency could not be saved or loaded. Your local choice is available for this
          visit.
        </small>
      )}
      {preference.storageError && (
        <small aria-live="polite">This browser cannot remember currency preferences.</small>
      )}
    </div>
  );
}

export function useExchangeRates(bases: ReadonlyArray<string>, quote: string) {
  const unique = [...new Set(bases)].filter((base) => base !== quote).toSorted();

  const query = useQuery({
    queryKey: ["exchange-rates", quote, unique],
    queryFn: () => exchangeRatesFn({ data: { bases: unique, quote } }),
    enabled: quote !== "" && unique.length > 0 && unique.length <= 12,
    staleTime: 3600000,
    retry: false,
  });

  const rates: ReadonlyMap<string, ExchangeRate> = new Map(
    (query.data ?? []).map((rate) => [rate.base, rate]),
  );

  return { rates, unavailable: query.isError || unique.length > 12, loading: query.isFetching };
}

export type PriceAvailability = "priced" | "unavailable";

/**
 * Price display state for comparable menu lines. Unknown prices never
 * render as zero, "free", or "from" — they render through PriceUnavailable.
 * Invalid amount/currency pairs (already rejected at the import boundary)
 * are treated as unavailable rather than rendered.
 */
export function priceAvailability(
  amount: string | null,
  currency: string | null,
): PriceAvailability {
  if (amount === null || currency === null) return "unavailable";

  if (!isAmount(amount) || !isCurrency(currency)) return "unavailable";

  return "priced";
}

/**
 * Explicit unknown-price state. Never renders ₫0, "Free", or "From ₫X":
 * a missing price is a missing price, not a zero price.
 */
export function PriceUnavailable({ label = "Price unavailable" }: { label?: string }) {
  return <p className="res-price-na">{label}</p>;
}

/**
 * Compact source/observation context for one comparable price line.
 * One info icon plus a single short line; the full context rides the
 * title tooltip so dense comparison lists stay uncrowded.
 */
export function PriceProvenance({
  observedAt,
  sourceCategory,
  channelLabel,
  stale,
  staleLabel = "May be out of date — confirm with the venue",
}: {
  observedAt: string;
  sourceCategory: string | null;
  channelLabel: string;
  stale: boolean;
  staleLabel?: string;
}) {
  const source = sourceCategory === null ? null : sourceCategory.replaceAll("_", " ");

  const detail = [`observed ${observedAt}`, source, channelLabel, stale ? staleLabel : null]
    .flatMap((part) => (part === null ? [] : [part]))
    .join(" · ");

  return (
    <p className="res-match-meta" title={detail}>
      <Info aria-hidden="true" className="res-provenance-icon" />
      <span>
        {observedAt}
        {stale ? ` · ${staleLabel}` : null}
      </span>
    </p>
  );
}

export function ObservedPrice({
  amount,
  currency,
  locale,
  rate,
}: {
  amount: string;
  currency: string;
  locale: string;
  rate?: ExchangeRate;
}) {
  let converted: string | null = null;

  if (rate !== undefined && rate.quote !== currency)
    converted = convertAmount(amount, currency, rate.quote, rate);

  return (
    <div className="observed-price">
      <p className="text-xl font-semibold tabular-nums">
        {formatMoney(amount, currency, locale)}{" "}
        <span className="text-xs font-normal">{currency}</span>
      </p>
      {converted !== null && rate !== undefined && (
        <p
          className="text-sm text-muted italic tabular-nums"
          title={`Reference rate ${rate.effectiveDate} · ${rate.provider}`}
        >
          ≈ {formatMoney(converted, rate.quote, locale)} {rate.quote}
          <span className="block text-xs">Rate dated {rate.effectiveDate}</span>
        </p>
      )}
    </div>
  );
}
