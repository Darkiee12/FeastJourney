import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  DraftPriceFields,
  ScanPriceFields,
  draftPriceValid,
} from "@/modules/restaurant-discovery/components/scan-price-editor";
import type { MenuDraftVariant } from "@/modules/restaurant-discovery/menu-presentation";
import { scanPriceSchema } from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";

export type ScanVariant = MenuScanDocument["items"][number]["variants"][number];

/** Editor for one extracted scan variant. Behavior matches the original inline version. */
export function VariantEditor({
  variant,
  locale,
  sourceLanguage,
  onChange,
}: {
  readonly variant: ScanVariant;
  readonly locale: string;
  readonly sourceLanguage: string;
  readonly onChange: (variant: ScanVariant) => void;
}) {
  const copy = menuCopy(locale);
  const price = variant.price;
  const priceValid = price === null || scanPriceSchema.safeParse(price).success;

  return (
    <div className="scan-editor-variant">
      {variant.customerAdded === true && <p>{copy.customerAdded}</p>}
      <label htmlFor={`edit-variant-${variant.id}`}>{copy.originalVariant}</label>
      <input
        id={`edit-variant-${variant.id}`}
        lang={sourceLanguage}
        maxLength={200}
        value={variant.originalLabel}
        onChange={(event) => onChange({ ...variant, originalLabel: event.target.value })}
      />
      <label htmlFor={`edit-variant-translation-${variant.id}`}>{copy.translatedVariant}</label>
      <input
        id={`edit-variant-translation-${variant.id}`}
        lang={locale}
        maxLength={300}
        value={variant.translatedLabel ?? ""}
        onChange={(event) =>
          onChange({
            ...variant,
            translatedLabel: event.target.value === "" ? null : event.target.value,
          })
        }
      />
      {price === null ? (
        <>
          <p>{copy.noPrice}</p>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...variant,
                price: { rawText: "", amount: null, currency: null, taxTreatment: "unknown" },
              })
            }
          >
            {copy.enterPrice}
          </button>
        </>
      ) : (
        <>
          <ScanPriceFields
            locale={locale}
            variantId={variant.id}
            price={price}
            priceValid={priceValid}
            onChange={(next) => onChange({ ...variant, price: next })}
          />
          <button type="button" onClick={() => onChange({ ...variant, price: null })}>
            {copy.clearPrice}
          </button>
        </>
      )}
    </div>
  );
}

/** Editor for one curator draft variant. Behavior matches the original inline version. */
export function DraftVariantEditor({
  variant,
  locale,
  sourceLanguage,
  onChange,
  onRemove,
  canRemove,
}: {
  readonly variant: MenuDraftVariant;
  readonly locale: string;
  readonly sourceLanguage: string;
  readonly onChange: (variant: MenuDraftVariant) => void;
  readonly onRemove: () => void;
  readonly canRemove: boolean;
}) {
  const copy = menuCopy(locale);
  const price = variant.price;
  const valid = draftPriceValid(price);

  return (
    <div className="scan-editor-variant">
      <label htmlFor={`draft-variant-${variant.clientKey}`}>{copy.originalVariant}</label>
      <input
        id={`draft-variant-${variant.clientKey}`}
        lang={sourceLanguage}
        maxLength={200}
        value={variant.label}
        onChange={(event) => onChange({ ...variant, label: event.target.value })}
      />
      <label htmlFor={`draft-variant-translation-${variant.clientKey}`}>
        {copy.translatedVariant}
      </label>
      <input
        id={`draft-variant-translation-${variant.clientKey}`}
        lang={locale}
        maxLength={300}
        value={variant.translatedLabel ?? ""}
        onChange={(event) =>
          onChange({
            ...variant,
            translatedLabel: event.target.value === "" ? undefined : event.target.value,
          })
        }
      />
      {price === null ? (
        <>
          <p>{copy.noPrice}</p>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...variant,
                price: {
                  rawText: "",
                  amount: null,
                  currency: null,
                  channel: "dine_in",
                  taxTreatment: "unknown",
                },
              })
            }
          >
            {copy.enterPrice}
          </button>
        </>
      ) : (
        <>
          <DraftPriceFields
            locale={locale}
            clientKey={variant.clientKey}
            price={price}
            valid={valid}
            onChange={(next) => onChange({ ...variant, price: next })}
          />
          <button type="button" onClick={() => onChange({ ...variant, price: null })}>
            {copy.clearPrice}
          </button>
        </>
      )}
      {canRemove && (
        <button type="button" onClick={onRemove}>
          {copy.removeVariant}
        </button>
      )}
    </div>
  );
}
