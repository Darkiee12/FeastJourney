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
 * Coarsened location evidence for currency inference (§3/§4).
 * Deterministic precedence, strongest first:
 * printed symbol > linked venue (verified menu location) >
 * visitor-selected menu city/country (server-resolved through the place
 * catalog) > trusted visitor country (weak) > unknown.
 * Menu location always outweighs visitor location. Locale, translation,
 * and display currency are never location evidence and are absent by
 * design. Conflicting signals are stated as conflict so the model stays
 * uncertain instead of silently resolving one side away.
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
 * Presets carry no country here — the extraction operation resolves the
 * country for these names through the place catalog (see
 * resolvePlaceMenuEvidence in server/operations/menu-scans), never through
 * a preset-to-country map in this module.
 */
const KNOWN_MENU_CITIES: ReadonlyMap<string, string> = new Map([
  ["hcmc", "Ho Chi Minh City"],
  ["hanoi", "Hanoi"],
  ["bangalore", "Bangalore"],
]);

/**
 * menuCityId boundary grammar (visitor-indicated menu location, weak
 * evidence only):
 * - curated preset ids: "hcmc" | "hanoi" | "bangalore"
 * - "geo:<name>": nearest-city display name from the catalog city chooser
 *   (the embedded name passes through; empty names degrade to null)
 * - "place:<decimalId>": canonical place registry identity (resolved
 *   server-side to a coarse city display name plus country ISO;
 *   unknown/missing records degrade to null, never geography)
 * Anything else is rejected at the schema boundary; the server never
 * trusts client display labels as geography. Max length stays 80.
 */
export const MENU_CITY_PRESET_IDS: ReadonlyArray<string> = [...KNOWN_MENU_CITIES.keys()];

export const MENU_CITY_GEO_PREFIX = "geo:";

export const MENU_CITY_PLACE_PREFIX = "place:";

const PLACE_MENU_ID_PATTERN = /^place:[0-9]+$/;

export const isMenuCityId = (value: string): boolean => {
  if (KNOWN_MENU_CITIES.has(value)) return true;

  if (value.startsWith(MENU_CITY_GEO_PREFIX)) return true;

  return PLACE_MENU_ID_PATTERN.test(value);
};

/**
 * Pure parse of a `place:<decimalId>` menu city id to its decimal registry
 * identity, or null when the value is not a well-formed place reference.
 * No I/O: the extraction operation resolves the returned id against the
 * place catalog; unknown/missing records degrade to null there.
 */
export const parsePlaceMenuCityId = (cityId: string | null | undefined): string | null => {
  if (cityId === null || cityId === undefined) return null;

  const trimmed = cityId.trim();

  if (!trimmed.startsWith(MENU_CITY_PLACE_PREFIX)) return null;

  const raw = trimmed.slice(MENU_CITY_PLACE_PREFIX.length);

  return /^[0-9]+$/.test(raw) ? raw : null;
};

/**
 * Resolve a client-supplied menu city id to coarse evidence text. Curated
 * preset ids map to fixed names; `geo:` ids (nearest-city resolution) pass
 * through the embedded name only. `place:` registry ids need catalog I/O
 * to become evidence, so this sync display-name resolver drops them —
 * async resolution lives in the extraction operation. Anything else is
 * dropped: the client is never trusted to assert geography with an
 * arbitrary string.
 */
export const resolveMenuCityId = (cityId: string | null | undefined): string | null => {
  if (cityId === null || cityId === undefined) return null;

  const trimmed = cityId.trim();

  if (trimmed.length === 0) return null;

  if (trimmed.startsWith(MENU_CITY_PLACE_PREFIX)) return null;

  const known = KNOWN_MENU_CITIES.get(trimmed);

  if (known !== undefined) return known;

  if (trimmed.startsWith(MENU_CITY_GEO_PREFIX))
    return cleanPlace(trimmed.slice(MENU_CITY_GEO_PREFIX.length));

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
 * evidence exists. Precedence is encoded by order: linked venue first, then
 * the visitor-indicated menu location, then the weak visitor country. A
 * menu country that disagrees with the visitor country is stated as an
 * explicit conflict so the model stays uncertain instead of picking one.
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

  if (
    context.menuCountry !== null &&
    context.trustedCountry !== null &&
    context.menuCountry !== context.trustedCountry
  )
    parts.push(
      `conflicting signals: menu location names ${context.menuCountry} but visitor country is ${context.trustedCountry}; stay uncertain, do not resolve the conflict`,
    );

  if (parts.length === 0) return null;

  return `Coarse location evidence (weak; printed currency always wins): ${parts.join("; ")}. Menu language is not location evidence.`;
};

/**
 * Deterministic menu-country read for the results lane: the
 * server-resolved menu country (place-catalog evidence) outweighs the weak
 * trusted visitor country; absent both, the country is unknown. Printed
 * symbols outrank this read at inference time (see the model prompt), and
 * locale, translation, and display currency never feed it — no such inputs
 * exist on this boundary. Conflicts are preserved in the evidence sentence
 * above, never silently resolved here beyond this order.
 */
export const resolveMenuCountry = (context: CurrencyContext): string | null => {
  if (context.menuCountry !== null) return context.menuCountry;

  if (context.trustedCountry !== null) return context.trustedCountry;

  return null;
};
