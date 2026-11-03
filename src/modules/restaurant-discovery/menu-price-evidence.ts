import { Data } from "effect";
import { z } from "zod";

/**
 * Price-evidence domain for menu scans (§4).
 *
 * Separates four concerns that must never collapse into one vague "known
 * price" state: raw OCR text, parsed numeric amount, currency identity with
 * provenance, and item/variant price association. Display layers import the
 * code types only; server operations own resolution and logging.
 */

export const currencyProvenances = ["printed", "inferred", "user-confirmed", "unknown"] as const;

export type CurrencyProvenanceCode = (typeof currencyProvenances)[number];

export const currencyProvenanceSchema = z.enum(currencyProvenances);

export const priceAssociations = ["clear", "ambiguous", "unavailable"] as const;

export type PriceAssociationCode = (typeof priceAssociations)[number];

export const priceAssociationSchema = z.enum(priceAssociations);

/** Short reviewer-facing note; never a second association channel. */
export const associationNoteSchema = z.string().trim().min(1).max(200);

export type CurrencyProvenance = Data.TaggedEnum<{
  readonly Printed: {};
  readonly Inferred: {};
  readonly UserConfirmed: {};
  readonly Unknown: {};
}>;

export const CurrencyProvenance = Data.taggedEnum<CurrencyProvenance>();

export type PriceAssociation = Data.TaggedEnum<{
  readonly Clear: {};
  readonly Ambiguous: { readonly note: string | null };
  readonly Unavailable: {};
}>;

export const PriceAssociation = Data.taggedEnum<PriceAssociation>();

const provenanceConstructors: ReadonlyMap<string, () => CurrencyProvenance> = new Map([
  ["printed", (): CurrencyProvenance => CurrencyProvenance.Printed()],
  ["inferred", (): CurrencyProvenance => CurrencyProvenance.Inferred()],
  ["user-confirmed", (): CurrencyProvenance => CurrencyProvenance.UserConfirmed()],
]);

const settledAssociationConstructors: ReadonlyMap<string, () => PriceAssociation> = new Map([
  ["clear", (): PriceAssociation => PriceAssociation.Clear()],
  ["unavailable", (): PriceAssociation => PriceAssociation.Unavailable()],
]);

export const currencyProvenanceFromCode = (code: string | null | undefined): CurrencyProvenance => {
  const construct =
    code === null || code === undefined ? undefined : provenanceConstructors.get(code);

  return construct === undefined ? CurrencyProvenance.Unknown() : construct();
};

export const currencyProvenanceToCode = (provenance: CurrencyProvenance): CurrencyProvenanceCode =>
  CurrencyProvenance.$match(provenance, {
    Printed: () => "printed" as const,
    Inferred: () => "inferred" as const,
    UserConfirmed: () => "user-confirmed" as const,
    Unknown: () => "unknown" as const,
  });

export const priceAssociationFromCode = (
  code: string | null | undefined,
  note: string | null | undefined,
): PriceAssociation => {
  if (code === "ambiguous") {
    return PriceAssociation.Ambiguous({ note: note ?? null });
  }

  const construct =
    code === null || code === undefined ? undefined : settledAssociationConstructors.get(code);

  return construct === undefined ? PriceAssociation.Clear() : construct();
};

export const priceAssociationToCode = (association: PriceAssociation): PriceAssociationCode =>
  PriceAssociation.$match(association, {
    Clear: () => "clear" as const,
    Ambiguous: () => "ambiguous" as const,
    Unavailable: () => "unavailable" as const,
  });

/**
 * Legacy default: documents written before provenance existed keep their
 * previous projection. Absent provenance reads as unknown (never reinterpret
 * an old record as printed); absent association reads as clear so existing
 * confirmed renderings do not move. New model output always writes both.
 */
export const provenanceOf = (price: {
  readonly currencyProvenance?: CurrencyProvenanceCode | undefined;
}): CurrencyProvenance => currencyProvenanceFromCode(price.currencyProvenance ?? null);

export const associationOf = (price: {
  readonly association?: PriceAssociationCode | undefined;
  readonly associationNote?: string | null | undefined;
}): PriceAssociation =>
  price.association === undefined
    ? PriceAssociation.Clear()
    : priceAssociationFromCode(price.association, price.associationNote ?? null);

/** Printed or user-confirmed currency may render without a qualifier. */
export const isSettledCurrency = (provenance: CurrencyProvenance): boolean =>
  CurrencyProvenance.$match(provenance, {
    Printed: () => true,
    Inferred: () => false,
    UserConfirmed: () => true,
    Unknown: () => false,
  });

/** Ambiguous association or unknown currency needs reviewer/visitor review. */
export const needsPriceReview = (price: {
  readonly currencyProvenance?: CurrencyProvenanceCode | undefined;
  readonly association?: PriceAssociationCode | undefined;
}): boolean =>
  PriceAssociation.$match(associationOf(price), {
    Clear: () => !isSettledCurrency(provenanceOf(price)),
    Ambiguous: () => true,
    Unavailable: () => true,
  });

/**
 * Coarsened location evidence for currency inference (§3/§4 precedence:
 * printed address > linked venue > user-selected > trusted country).
 * Only coarse city/country strings travel to Muse; raw GPS coordinates,
 * street addresses, and request headers never leave the server. Menu
 * language is not location evidence and is absent by design.
 */
export interface CurrencyContext {
  readonly venueName: string | null;
  readonly menuCountry: string | null;
  readonly menuCity: string | null;
  readonly trustedCountry: string | null;
}

export const emptyCurrencyContext: CurrencyContext = {
  venueName: null,
  menuCountry: null,
  menuCity: null,
  trustedCountry: null,
};

const ISO_COUNTRY = /^[A-Z]{2}$/;

/**
 * Curated preset city ids (mirrors CITY_PRESETS in map-bounds without
 * importing viewport geometry into the currency domain). Values are coarse
 * display names carried as weak visitor-indicated evidence only.
 */
const KNOWN_MENU_CITIES: ReadonlyMap<string, string> = new Map([
  ["hcmc", "Ho Chi Minh City"],
  ["hanoi", "Hanoi"],
  ["bangalore", "Bangalore"],
]);

/**
 * Resolve a client-supplied menu city id to coarse evidence text. Curated
 * preset ids map to fixed names; `geo:` ids (nearest-city resolution) pass
 * through the embedded name only; anything else is dropped — the client is
 * never trusted to assert geography with an arbitrary string.
 */
export const resolveMenuCityId = (cityId: string | null | undefined): string | null => {
  if (cityId === null || cityId === undefined) return null;

  const trimmed = cityId.trim();

  if (trimmed.length === 0) return null;

  const known = KNOWN_MENU_CITIES.get(trimmed);

  if (known !== undefined) return known;

  if (trimmed.startsWith("geo:")) return cleanPlace(trimmed.slice(4));

  return null;
};

const cleanPlace = (value: string | null): string | null => {
  if (value === null) return null;

  const trimmed = value.trim().slice(0, 120);

  return trimmed.length === 0 ? null : trimmed;
};

/** Pure normalizer: trims, upper-cases country codes, drops invalid codes. */
export const normalizeCurrencyContext = (input: {
  readonly venueName?: string | null | undefined;
  readonly menuCountry?: string | null | undefined;
  readonly menuCity?: string | null | undefined;
  readonly trustedCountry?: string | null | undefined;
}): CurrencyContext => {
  const country = (input.menuCountry ?? "").trim().toUpperCase();
  const trusted = (input.trustedCountry ?? "").trim().toUpperCase();

  return {
    venueName: cleanPlace(input.venueName ?? null),
    menuCountry: ISO_COUNTRY.test(country) ? country : null,
    menuCity: cleanPlace(input.menuCity ?? null),
    trustedCountry: ISO_COUNTRY.test(trusted) ? trusted : null,
  };
};

/**
 * Single coarsened evidence sentence for the model prompt, or null when no
 * evidence exists. Precedence is encoded by order; conflicting signals are
 * stated as conflict so the model stays uncertain instead of picking one.
 */
export const formatCurrencyContextEvidence = (context: CurrencyContext): string | null => {
  const parts: Array<string> = [];

  if (context.venueName !== null) parts.push(`linked venue "${context.venueName}"`);

  if (context.menuCity !== null || context.menuCountry !== null)
    parts.push(
      `visitor-indicated menu location ${[context.menuCity, context.menuCountry].filter((part) => part !== null).join(", ")}`,
    );

  if (context.trustedCountry !== null)
    parts.push(`coarse visitor country ${context.trustedCountry}`);

  if (parts.length === 0) return null;

  return `Coarse location evidence (weak; printed currency always wins): ${parts.join("; ")}. Menu language is not location evidence.`;
};
