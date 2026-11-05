import type { z } from "zod";

import {
  menuCopy,
  menuResultsCopy,
  menuScanResultsCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { SearchableCurrencyPicker } from "@/modules/restaurant-discovery/components/searchable-currency-picker";
import type { MenuDraftVariantPrice } from "@/modules/restaurant-discovery/menu-presentation";
import type { CurrencyProvenanceCode } from "@/modules/restaurant-discovery/menu-price-evidence";
import { interpretPrintedPrice } from "@/modules/restaurant-discovery/menu-price-interpretation";
import { scanPriceSchema } from "@/modules/restaurant-discovery/menu-scan.schema";
import { currencyMinorUnits } from "@/shared/currencies";
import { formatMoney, isAmount, isCurrency } from "@/shared/money";

type ScanPrice = z.infer<typeof scanPriceSchema>;

/**
 * What the menu display derives from the raw printed text. Shown so the
 * reviewer can trace the rendered price back to its interpretation — never
 * silently baked in. Applying writes the derived values with the derived
 * provenance (`printed` only when the symbol is actually in the raw text,
 * otherwise `inferred`); it never invents a printed claim.
 */
function InterpretedPreview({
  locale,
  interpreted,
  alreadyApplied,
  onApply,
}: {
  readonly locale: string;
  readonly interpreted: {
    readonly amount: string | null;
    readonly currency: string | null;
    readonly currencyProvenance?: CurrencyProvenanceCode | undefined;
  };
  readonly alreadyApplied: boolean;
  readonly onApply: () => void;
}) {
  const nothingDerived = interpreted.amount === null && interpreted.currency === null;

  if (nothingDerived || alreadyApplied) return null;

  const provenance = interpreted.currencyProvenance ?? "unknown";
  const scanCopy = menuScanResultsCopy(locale);
  let provenanceNote = menuResultsCopy(locale).currencyUnconfirmed;

  if (provenance === "printed") provenanceNote = menuCopy(locale).asListed;
  else if (provenance === "inferred") provenanceNote = scanCopy.priceInferredNote;
  else if (provenance === "user-confirmed") provenanceNote = scanCopy.currencyConfirmedNote;

  return (
    <p className="scan-price-interpreted">
      <span>
        {locale === "vi" ? "Diễn giải:" : "Interpreted:"}{" "}
        {interpreted.amount !== null && interpreted.currency !== null
          ? formatMoney(interpreted.amount, interpreted.currency, locale)
          : (interpreted.amount ?? interpreted.currency ?? menuCopy(locale).unknown)}
      </span>{" "}
      <span>{provenanceNote}</span>
      <button type="button" onClick={onApply}>
        {locale === "vi" ? "Dùng giá trị diễn giải" : "Use interpreted values"}
      </button>
    </p>
  );
}

/** Price sub-form for an extracted scan variant. Markup mirrors ScanEditor exactly. */
export function ScanPriceFields({
  locale,
  variantId,
  price,
  priceValid,
  onChange,
  menuCountry,
}: {
  readonly locale: string;
  readonly variantId: string;
  readonly price: ScanPrice;
  readonly priceValid: boolean;
  readonly onChange: (price: ScanPrice) => void;
  readonly menuCountry?: string | null | undefined;
}) {
  const copy = menuCopy(locale);

  const interpreted = interpretPrintedPrice(price, menuCountry ?? null);

  const alreadyApplied =
    interpreted.amount === price.amount &&
    interpreted.currency === price.currency &&
    (interpreted.currencyProvenance ?? "unknown") === (price.currencyProvenance ?? "unknown") &&
    (interpreted.unit ?? null) === (price.unit ?? null);

  return (
    <>
      <label htmlFor={`edit-raw-price-${variantId}`}>{copy.rawPrice}</label>
      <input
        id={`edit-raw-price-${variantId}`}
        maxLength={200}
        value={price.rawText}
        onChange={(event) => onChange({ ...price, rawText: event.target.value })}
      />
      <InterpretedPreview
        locale={locale}
        interpreted={interpreted}
        alreadyApplied={alreadyApplied}
        onApply={() =>
          onChange({
            ...price,
            amount: interpreted.amount,
            currency: interpreted.currency,
            currencyProvenance: interpreted.currencyProvenance,
            unit: interpreted.unit ?? null,
          })
        }
      />
      <label htmlFor={`edit-amount-${variantId}`}>{copy.exactAmount}</label>
      <input
        id={`edit-amount-${variantId}`}
        inputMode="decimal"
        maxLength={49}
        aria-invalid={!priceValid}
        value={price.amount ?? ""}
        onChange={(event) =>
          onChange({
            ...price,
            amount: event.target.value === "" ? null : event.target.value,
          })
        }
      />
      <SearchableCurrencyPicker
        value={price.currency ?? ""}
        codes={[...currencyMinorUnits.keys()]}
        locale={locale}
        label={copy.currency}
        placeholder={copy.currency}
        onChange={(currency) =>
          onChange({ ...price, currency, currencyProvenance: "user-confirmed" })
        }
      />
      <button
        type="button"
        onClick={() => onChange({ ...price, currency: null, currencyProvenance: "unknown" })}
      >
        {menuResultsCopy(locale).currencyUnconfirmed}
      </button>
      <details>
        <summary>{copy.taxes}</summary>
        <label htmlFor={`edit-tax-${variantId}`}>{copy.taxes}</label>
        <select
          id={`edit-tax-${variantId}`}
          value={price.taxTreatment}
          onChange={(event) => {
            const treatment = scanPriceSchema.shape.taxTreatment.parse(event.target.value);
            onChange({ ...price, taxTreatment: treatment });
          }}
        >
          <option value="unknown">{copy.unknown}</option>
          <option value="included">{copy.included}</option>
          <option value="excluded">{copy.excluded}</option>
        </select>
      </details>
    </>
  );
}

/** Price sub-form for a curator draft variant, including the sales channel. */
export function DraftPriceFields({
  locale,
  clientKey,
  price,
  valid,
  onChange,
}: {
  readonly locale: string;
  readonly clientKey: string;
  readonly price: MenuDraftVariantPrice;
  readonly valid: boolean;
  readonly onChange: (price: MenuDraftVariantPrice) => void;
}) {
  const copy = menuCopy(locale);

  return (
    <>
      <label htmlFor={`draft-raw-price-${clientKey}`}>{copy.rawPrice}</label>
      <input
        id={`draft-raw-price-${clientKey}`}
        maxLength={200}
        value={price.rawText}
        onChange={(event) => onChange({ ...price, rawText: event.target.value })}
      />
      <label htmlFor={`draft-amount-${clientKey}`}>{copy.exactAmount}</label>
      <input
        id={`draft-amount-${clientKey}`}
        inputMode="decimal"
        maxLength={49}
        aria-invalid={!valid}
        value={price.amount ?? ""}
        onChange={(event) =>
          onChange({ ...price, amount: event.target.value === "" ? null : event.target.value })
        }
      />
      <label htmlFor={`draft-currency-${clientKey}`}>{copy.currency}</label>
      <input
        id={`draft-currency-${clientKey}`}
        maxLength={3}
        autoCapitalize="characters"
        aria-invalid={!valid}
        value={price.currency ?? ""}
        onChange={(event) =>
          onChange({
            ...price,
            currency: event.target.value === "" ? null : event.target.value.toUpperCase(),
          })
        }
      />
      <label htmlFor={`draft-channel-${clientKey}`}>
        {locale === "vi" ? "Giá này áp dụng ở đâu" : "Where this price applies"}
      </label>
      <select
        id={`draft-channel-${clientKey}`}
        value={price.channel}
        onChange={(event) => onChange({ ...price, channel: event.target.value })}
      >
        <option value="dine_in">{locale === "vi" ? "Tại quán" : "Dine in"}</option>
        <option value="takeaway">{locale === "vi" ? "Mang đi" : "Takeaway"}</option>
        <option value="delivery">{locale === "vi" ? "Giao hàng" : "Delivery"}</option>
      </select>
      <label htmlFor={`draft-tax-${clientKey}`}>{copy.taxes}</label>
      <select
        id={`draft-tax-${clientKey}`}
        value={price.taxTreatment}
        onChange={(event) => onChange({ ...price, taxTreatment: event.target.value })}
      >
        <option value="unknown">{copy.unknown}</option>
        <option value="included">{copy.included}</option>
        <option value="excluded">{copy.excluded}</option>
      </select>
    </>
  );
}

export const draftPriceValid = (price: MenuDraftVariantPrice | null): boolean => {
  if (price === null) return true;

  if (price.amount !== null && !isAmount(price.amount)) return false;

  if (price.currency !== null && !isCurrency(price.currency)) return false;

  return true;
};
