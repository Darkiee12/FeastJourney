import type { z } from "zod";

import { menuCopy, menuResultsCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { SearchableCurrencyPicker } from "@/modules/restaurant-discovery/components/searchable-currency-picker";
import type { MenuDraftVariantPrice } from "@/modules/restaurant-discovery/menu-presentation";
import { scanPriceSchema } from "@/modules/restaurant-discovery/menu-scan.schema";
import { currencyMinorUnits } from "@/shared/currencies";
import { isAmount, isCurrency } from "@/shared/money";

type ScanPrice = z.infer<typeof scanPriceSchema>;

/** Price sub-form for an extracted scan variant. Markup mirrors ScanEditor exactly. */
export function ScanPriceFields({
  locale,
  variantId,
  price,
  priceValid,
  onChange,
}: {
  readonly locale: string;
  readonly variantId: string;
  readonly price: ScanPrice;
  readonly priceValid: boolean;
  readonly onChange: (price: ScanPrice) => void;
}) {
  const copy = menuCopy(locale);

  return (
    <>
      <label htmlFor={`edit-raw-price-${variantId}`}>{copy.rawPrice}</label>
      <input
        id={`edit-raw-price-${variantId}`}
        maxLength={200}
        value={price.rawText}
        onChange={(event) => onChange({ ...price, rawText: event.target.value })}
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
