import type { DishPlaceAssociation, DishPlaceRef } from "@/components/admin/dish/edit-contracts";
import type { Locale } from "@/shared/i18n";

/**
 * Client-side parser + preview formatter for the dish↔place reference
 * grammar. Mirrors the server import grammar exactly:
 *
 *   `VN` / `VN:origin`            — ISO country, default associated
 *   `place:45` / `place:45:popular` — registry place id, default associated
 *   `Hanoi@VN` / `Hanoi@VN:associated` — city under an ISO parent
 *
 * Pure functions (no backend): used by the dish Places editor, the admin
 * place selector preview, and the import-studio grammar examples. Unknown
 * registry ids resolve server-side and surface as review issues; the parser
 * only rejects malformed shapes so curators fix the cell instead of
 * shipping a dangling link.
 *
 * City (`City@ISO`) and bare ISO previews are syntactically valid but
 * unverified until save: they describe a locality that may not exist in the
 * place registry yet. Only `place:<id>` refs reference the registry
 * directly (see isVerifiedPlaceRef).
 */

const ASSOCIATIONS: ReadonlyArray<DishPlaceAssociation> = ["origin", "associated", "popular"];

const ISO_PATTERN = /^[A-Za-z]{2}(?:-[A-Za-z0-9]{1,3})?$/;

/** Canonical registry id shape (`place:<id>` payload and `parentId` filters). */
const CANONICAL_PLACE_ID_PATTERN = /^[0-9]+$/;

/** True for a trimmed decimal registry id — never grammar, ISO, or blank. */
export const isCanonicalPlaceId = (value: string): boolean =>
  CANONICAL_PLACE_ID_PATTERN.test(value.trim());

/**
 * Boundary normalizer for the parent filter: trims UI input and keeps only
 * canonical decimal ids. Anything else (blank, grammar, ISO) reads as no
 * filter so the registry listing can never receive a malformed `parentId`.
 */
export const normalizeParentId = (value: string): string | null => {
  const trimmed = value.trim();

  if (!isCanonicalPlaceId(trimmed)) {
    return null;
  }

  return trimmed;
};

export type PlaceRefParseError = "required" | "invalid";

export interface ParsedPlaceRef {
  readonly ref: DishPlaceRef;
  readonly association: DishPlaceAssociation;
}

const parseAssociation = (raw: string | undefined): DishPlaceAssociation | null => {
  if (raw === undefined || raw.trim() === "") {
    return "associated";
  }

  const normalized = raw.trim().toLowerCase();

  return ASSOCIATIONS.find((entry) => entry === normalized) ?? null;
};

const parseIsoPart = (raw: string): string | null => {
  const iso = raw.trim();

  if (!ISO_PATTERN.test(iso)) {
    return null;
  }

  return iso.toUpperCase();
};

export const parsePlaceRef = (
  input: string,
):
  | { readonly ok: true; readonly value: ParsedPlaceRef }
  | { readonly ok: false; readonly error: PlaceRefParseError } => {
  const trimmed = input.trim();

  if (trimmed === "") {
    return { ok: false, error: "required" };
  }

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("place:")) {
    const segments = trimmed.slice("place:".length).split(":");
    const rawId = (segments[0] ?? "").trim();

    if (segments.length > 2 || !isCanonicalPlaceId(rawId)) {
      return { ok: false, error: "invalid" };
    }

    const association = parseAssociation(segments[1]);

    if (association === null) {
      return { ok: false, error: "invalid" };
    }

    return { ok: true, value: { ref: { placeId: rawId }, association } };
  }

  const atSign = trimmed.indexOf("@");

  if (atSign !== -1) {
    const city = trimmed.slice(0, atSign).trim();
    const rest = trimmed.slice(atSign + 1);
    const separator = rest.indexOf(":");
    const rawIso = separator === -1 ? rest : rest.slice(0, separator);
    const iso = parseIsoPart(rawIso);
    const association = parseAssociation(separator === -1 ? undefined : rest.slice(separator + 1));

    if (city === "" || iso === null || association === null) {
      return { ok: false, error: "invalid" };
    }

    return { ok: true, value: { ref: { city, parentIso: iso }, association } };
  }

  const separator = trimmed.indexOf(":");
  const rawIso = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const iso = parseIsoPart(rawIso);
  const association = parseAssociation(separator === -1 ? undefined : trimmed.slice(separator + 1));

  if (iso === null || association === null) {
    return { ok: false, error: "invalid" };
  }

  return { ok: true, value: { ref: { iso }, association } };
};

/**
 * True only for canonical registry refs (`place:<decimal-id>`, optional
 * `:association` suffix). City (`City@ISO`) and bare ISO refs parse fine
 * but are unverified until save — they name a locality, not a registry row.
 */
export const isVerifiedPlaceRef = (raw: string): boolean => {
  const parsed = parsePlaceRef(raw.trim());

  if (!parsed.ok) {
    return false;
  }

  return "placeId" in parsed.value.ref;
};

/** Geographic preview for a parsed ref — city/country context, never a raw id alone. */
export const formatPlaceRefPreview = (parsed: ParsedPlaceRef, lang: Locale): string => {
  const { ref, association } = parsed;

  if ("city" in ref) {
    return `${ref.city}, ${ref.parentIso} · ${association}`;
  }

  if ("iso" in ref) {
    return `${ref.iso} · ${association}`;
  }

  return lang === "vi"
    ? `Địa điểm registry #${ref.placeId} · ${association}`
    : `Registry place #${ref.placeId} · ${association}`;
};

/** Canonical display for a known place: "Hanoi, Vietnam", never a raw id alone. */
export const formatPlaceContext = (input: {
  readonly name: string | null;
  readonly parentName: string | null;
  readonly iso: string | null;
  readonly placeId: string;
  readonly lang: Locale;
}): string => {
  const { name, parentName, iso, placeId, lang } = input;

  if (name !== null && parentName !== null) {
    return `${name}, ${parentName}`;
  }

  if (name !== null && iso !== null) {
    return `${name}, ${iso}`;
  }

  if (name !== null) {
    return name;
  }

  return lang === "vi" ? `Địa điểm #${placeId}` : `Place #${placeId}`;
};
