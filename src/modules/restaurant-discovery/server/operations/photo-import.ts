/**
 * Rights-backed single-photo remote import (staff-gated, server-only).
 *
 * Owning module: restaurant-discovery. Application operation: Effect v4.
 * Browser-safe: no (imports server auth/authorization plumbing).
 * Transport: none in this file — the coordinator wires server functions.
 *
 * Pipeline stage (Find candidate → Verify source → Review rights → Import
 * → Review image → Publish): this file covers Verify source (SSRF-safe
 * fetch) + Review rights (license allowlist + attribution completeness)
 * + Import preparation (first-party staging input + scope decision).
 * Review image and Publish stay on the existing photo pipeline
 * (`stagePhoto` → `submitForReview` → `publishPhoto` in `photos.ts`),
 * which this file never modifies and never bypasses.
 *
 * Read-only reuse: `SUPPORTED_PHOTO_LICENSES` / `MAX_RESTAURANT_PHOTO_BYTES`
 * from `photos.ts`; `RestaurantPhotoStorage` put/get shape is reused by
 * routing bytes through `stagePhoto`, never by duplicating the adapter.
 * Dish association reads dish identity only through existing
 * dish-media-service read paths (evidence-backed), otherwise venue-scoped.
 * No crawling, scraping, bulk ingest, hotlinking, or new migrations.
 *
 * Proposed coordinator wiring (not implemented here):
 * `prepareRemoteImport` → `toStagePhotoInput` → existing
 * `RestaurantPhotoService.stagePhoto` → `submitForReview` → publish flow.
 * Staff gate: `restaurant:manage` at `prepareRemoteImport`; publication
 * keeps the existing `restaurant:review` bar plus the publish-time license
 * and attribution gates already in `photos.ts`.
 */

import { Data, Effect } from "effect";

import {
  MAX_RESTAURANT_PHOTO_BYTES,
  SUPPORTED_PHOTO_LICENSES,
} from "@/modules/restaurant-discovery/server/operations/photos";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import { CurrentActor } from "@/server/auth/current-actor";
import type { InsufficientPermissions } from "@/server/auth/errors";
import type { Database } from "@/server/database/client";
import type { DatabaseError } from "@/server/database/query";

/**
 * Licenses accepted for remote import: the three public Creative Commons
 * tiers plus documented permission (`licensed`). `own-work` is excluded on
 * purpose — a remote fetch is never the importer's own first-party upload,
 * so it must carry third-party rights evidence; own-work photos use the
 * direct upload pipeline. `unknown` and anything unlisted block import
 * (unspecified licenses can never publish).
 */
export const IMPORTABLE_PHOTO_LICENSES = ["cc0", "cc-by", "cc-by-sa", "licensed"] as const;

export type ImportablePhotoLicense = (typeof IMPORTABLE_PHOTO_LICENSES)[number];

const IMPORTABLE_LICENSES: ReadonlySet<string> = new Set(IMPORTABLE_PHOTO_LICENSES);

/** Redirect hops followed before giving up; every hop is re-validated. */
export const MAX_IMPORT_REDIRECTS = 3;

/** Per-request network budget for one candidate fetch. */
export const IMPORT_FETCH_TIMEOUT_MS = 15_000;

/** Byte ceiling mirrors the staging pipeline so fetched bytes always fit. */
export const MAX_IMPORT_BYTES = MAX_RESTAURANT_PHOTO_BYTES;

export class PhotoImportRightsBlocked extends Data.TaggedError("PhotoImportRightsBlocked")<{
  readonly reasons: ReadonlyArray<string>;
}> {}

export class PhotoImportFetchBlocked extends Data.TaggedError("PhotoImportFetchBlocked")<{
  readonly reason: string;
}> {}

export type PhotoImportError = PhotoImportRightsBlocked | PhotoImportFetchBlocked;

export interface PhotoRightsCandidate {
  readonly license: string;
  readonly creator: string | null;
  readonly title: string | null;
  /** Page where the work was found; required provenance for every import. */
  readonly sourceUrl: string | null;
  /** License deed or legal-text URL; required for cc-by / cc-by-sa. */
  readonly licenseUrl: string | null;
  /** What was changed; required when `adapted` is true. */
  readonly modificationNote: string | null;
  readonly adapted: boolean;
  /** Documented-permission reference; required for `licensed`. */
  readonly permissionRef: string | null;
}

export interface VerifiedPhotoRights {
  readonly license: ImportablePhotoLicense;
  readonly creator: string | null;
  readonly title: string | null;
  readonly sourceUrl: string;
  readonly licenseUrl: string | null;
  readonly modificationNote: string | null;
  readonly permissionRef: string | null;
  /** True for cc-by-sa: downstream review must preserve the notice. */
  readonly shareAlike: boolean;
}

export interface RightsCheck {
  readonly reasons: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly rights: VerifiedPhotoRights | null;
}

const MAX_RIGHTS_FIELD_CHARS = 500;

const trimmedOrNull = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Rights-verification gate, pure over staff input. Allowlist first, then
 * per-license attribution completeness: cc-by/cc-by-sa require
 * creator + title + source + license link; adaptation requires a
 * modification notice; cc-by-sa additionally propagates a ShareAlike flag
 * so the review step preserves it; `licensed` requires a documented
 * permission reference. CC0 needs no legal attribution but still requires
 * the source URL as provenance. Unspecified (`unknown`/blank) licenses
 * block outright — they can never publish.
 */
export const verifyPhotoRights = (candidate: PhotoRightsCandidate): RightsCheck => {
  const reasons: Array<string> = [];
  const warnings: Array<string> = [];
  const license = candidate.license.trim().toLowerCase();

  if (license === "" || license === "unknown") {
    reasons.push(
      "unspecified license blocks publication; attach cc0, cc-by, cc-by-sa, or licensed",
    );
  } else if (!IMPORTABLE_LICENSES.has(license)) {
    if (license === "own-work") {
      reasons.push(
        "own-work cannot be imported from a remote URL; upload first-party photos through the direct upload pipeline",
      );
    } else {
      reasons.push(
        `license "${candidate.license.trim()}" cannot be imported; attach ${IMPORTABLE_PHOTO_LICENSES.join(", ")}`,
      );
    }
  }

  const matched = IMPORTABLE_PHOTO_LICENSES.find((entry) => entry === license);
  const creator = trimmedOrNull(candidate.creator);
  const title = trimmedOrNull(candidate.title);
  const sourceUrl = trimmedOrNull(candidate.sourceUrl);
  const licenseUrl = trimmedOrNull(candidate.licenseUrl);
  const modificationNote = trimmedOrNull(candidate.modificationNote);
  const permissionRef = trimmedOrNull(candidate.permissionRef);

  for (const [label, value] of [
    ["creator", creator],
    ["title", title],
    ["license_url", licenseUrl],
    ["modification_note", modificationNote],
    ["permission_ref", permissionRef],
  ] as const) {
    if (value !== null && value.length > MAX_RIGHTS_FIELD_CHARS) {
      reasons.push(`${label} must be ${MAX_RIGHTS_FIELD_CHARS} characters or fewer`);
    }
  }

  if (sourceUrl === null) {
    reasons.push("source_url is required provenance for every import");
  } else if (!sourceUrl.startsWith("https://")) {
    reasons.push("source_url must be an https URL");
  }

  if (license === "cc-by" || license === "cc-by-sa") {
    if (creator === null) {
      reasons.push(`creator is required for ${license}`);
    }

    if (title === null) {
      reasons.push(`title is required for ${license}`);
    }

    if (licenseUrl === null) {
      reasons.push(`license_url is required for ${license}`);
    }

    if (candidate.adapted && modificationNote === null) {
      reasons.push(`modification_note is required when the ${license} work is adapted`);
    }
  }

  if (license === "cc0") {
    if (creator === null) {
      warnings.push("cc0 needs no legal attribution, but recording the creator aids review");
    }

    if (licenseUrl === null) {
      warnings.push("cc0 needs no legal attribution, but a license link aids review");
    }
  }

  if (license === "licensed") {
    if (permissionRef === null) {
      reasons.push("permission_ref is required for documented-permission imports");
    }

    if (creator === null) {
      warnings.push("recording the creator aids review of documented-permission imports");
    }
  }

  if (reasons.length > 0 || matched === undefined) {
    return { reasons, warnings, rights: null };
  }

  return {
    reasons,
    warnings,
    rights: {
      license: matched,
      creator,
      title,
      sourceUrl: sourceUrl ?? "",
      licenseUrl,
      modificationNote,
      permissionRef,
      shareAlike: license === "cc-by-sa",
    },
  };
};

export const checkPhotoRights = Effect.fn("restaurant-photo-import/check-rights")(function* (
  candidate: PhotoRightsCandidate,
) {
  const check = verifyPhotoRights(candidate);

  if (check.rights === null) {
    return yield* new PhotoImportRightsBlocked({ reasons: check.reasons });
  }

  return check.rights;
});

/**
 * Attribution line preserving creator/title/source/license-link and
 * modification notices for the downstream `stagePhoto` attribution field.
 * Never truncated here: dropping license text would falsify the record, so
 * over-long lines fail loudly at the existing 500-char review gate.
 */
export const buildImportAttribution = (rights: VerifiedPhotoRights): string => {
  const parts: Array<string> = [];

  if (rights.title !== null && rights.creator !== null) {
    parts.push(`"${rights.title}" by ${rights.creator}`);
  } else if (rights.creator !== null) {
    parts.push(rights.creator);
  } else if (rights.title !== null) {
    parts.push(`"${rights.title}"`);
  }

  let licenseLabel = LICENSE_LABELS.get(rights.license) ?? rights.license;

  if (rights.license === "licensed" && rights.permissionRef !== null) {
    licenseLabel = `${licenseLabel} (${rights.permissionRef})`;
  }

  parts.push(licenseLabel);

  if (rights.licenseUrl !== null) {
    parts.push(rights.licenseUrl);
  }

  parts.push(`source: ${rights.sourceUrl}`);

  if (rights.modificationNote !== null) {
    parts.push(`modifications: ${rights.modificationNote}`);
  }

  if (rights.shareAlike) {
    parts.push("ShareAlike: adaptations must carry this license");
  }

  return parts.join("; ");
};

const isDecimalOctets = (host: string): boolean => {
  const parts = host.split(".");

  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

const isPrivateIpv4 = (host: string): boolean => {
  const octets = host.split(".").map(Number);
  const [a, b] = octets;

  if (a === undefined || b === undefined) {
    return true;
  }

  if (a === 10 || a === 127 || a === 0) {
    return true;
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  if (a === 192 && b === 168) {
    return true;
  }

  if (a === 169 && b === 254) {
    return true;
  }

  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }

  if (a === 192 && b === 0) {
    return true;
  }

  if (a === 198 && (b === 18 || b === 19 || b === 51 || b === 100)) {
    return true;
  }

  if (a === 203 && b === 113) {
    return true;
  }

  if (a >= 224) {
    return true;
  }

  return false;
};

const isBlockedIpv6 = (host: string): boolean => {
  const lower = host.toLowerCase();

  if (lower === "::" || lower === "::1") {
    return true;
  }

  if (
    lower.startsWith("fe80:") ||
    lower.startsWith("fec0:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8") ||
    lower.startsWith("64:ff9b")
  ) {
    return true;
  }

  if (lower.includes(".")) {
    const tail = lower.slice(lower.lastIndexOf(":") + 1);

    return !isDecimalOctets(tail) || isPrivateIpv4(tail);
  }

  return false;
};

const BLOCKED_DNS_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".intranet"];

export interface ImportUrlGate {
  readonly url: URL;
}

/**
 * Static SSRF gate for one URL, re-applied to every redirect hop:
 * https-only, no credentials, default port only, no private/internal
 * literal IPs, no internal DNS names. Hostname resolution itself is a
 * documented residual risk (DNS rebinding): the gate runs before connect,
 * and redirects are followed manually so each hop is re-gated.
 */
export const assertImportUrlAllowed = (
  rawUrl: string,
): ImportUrlGate | { readonly reason: string } => {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return { reason: "candidate URL is not parseable" };
  }

  if (parsed.protocol !== "https:") {
    return { reason: "candidate URL must use https" };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { reason: "candidate URL must not carry credentials" };
  }

  if (parsed.port !== "") {
    return { reason: "candidate URL must use the default https port" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");

  if (host === "") {
    return { reason: "candidate URL has no host" };
  }

  if (host === "localhost" || BLOCKED_DNS_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { reason: `candidate host "${parsed.hostname}" is internal` };
  }

  if (host.includes(":")) {
    if (isBlockedIpv6(host)) {
      return { reason: `candidate host "${parsed.hostname}" is not public` };
    }

    return { url: parsed };
  }

  if (isDecimalOctets(host)) {
    if (isPrivateIpv4(host)) {
      return { reason: `candidate host "${parsed.hostname}" is not public` };
    }

    return { url: parsed };
  }

  if (!host.includes(".")) {
    return { reason: `candidate host "${parsed.hostname}" is not a public DNS name` };
  }

  return { url: parsed };
};

export interface FetchedImportBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Final URL after redirects: the provenance recorded downstream. */
  readonly sourceUrl: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const FILENAME_BY_CONTENT_TYPE: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "import.jpg"],
  ["image/png", "import.png"],
  ["image/webp", "import.webp"],
]);

const LICENSE_LABELS: ReadonlyMap<ImportablePhotoLicense, string> = new Map([
  ["cc0", "CC0"],
  ["cc-by", "CC BY"],
  ["cc-by-sa", "CC BY-SA"],
  ["licensed", "used with permission"],
]);

const filenameForContentType = (contentType: string): string =>
  FILENAME_BY_CONTENT_TYPE.get(contentType) ?? "import.bin";

/**
 * SSRF-safe remote fetch with an injectable fetch implementation (the
 * second parameter is a test seam; production passes the platform fetch).
 * Manual redirect handling keeps every hop under the static gate; the
 * content-type allowlist (`image/*`), byte cap, and timeout bound the
 * download. Failure messages stay generic so candidate URLs (which may
 * carry tokens) never leak into logs.
 */
export const fetchImportBytes = (
  rawUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = IMPORT_FETCH_TIMEOUT_MS,
): Effect.Effect<FetchedImportBytes, PhotoImportFetchBlocked> =>
  Effect.tryPromise({
    try: async (signal) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);

      // Redirect hops are inherently serial: each hop is fetched and
      // re-gated before the next is attempted, so the chain recurses
      // instead of awaiting inside a loop.
      const follow = async (current: string, hop: number): Promise<FetchedImportBytes> => {
        const gated = assertImportUrlAllowed(current);

        if (!("url" in gated)) {
          throw new PhotoImportFetchBlocked({ reason: gated.reason });
        }

        if (hop > MAX_IMPORT_REDIRECTS) {
          throw new PhotoImportFetchBlocked({ reason: "too many redirects" });
        }

        const response = await fetchImpl(gated.url.toString(), {
          redirect: "manual",
          signal: combined,
        });

        const location = response.headers.get("location");

        if (REDIRECT_STATUS.has(response.status) && location !== null) {
          return follow(new URL(location, gated.url.toString()).toString(), hop + 1);
        }

        if (!response.ok) {
          throw new PhotoImportFetchBlocked({ reason: `source answered ${response.status}` });
        }

        const rawContentType = response.headers.get("content-type");
        const contentType = rawContentType?.split(";")[0]?.trim().toLowerCase() ?? "";

        if (!contentType.startsWith("image/")) {
          throw new PhotoImportFetchBlocked({ reason: "source is not an image" });
        }

        const declared = response.headers.get("content-length");

        if (
          declared !== null &&
          Number.isFinite(Number(declared)) &&
          Number(declared) > MAX_IMPORT_BYTES
        ) {
          throw new PhotoImportFetchBlocked({ reason: "source exceeds the import byte ceiling" });
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        if (bytes.byteLength === 0) {
          throw new PhotoImportFetchBlocked({ reason: "source returned no bytes" });
        }

        if (bytes.byteLength > MAX_IMPORT_BYTES) {
          throw new PhotoImportFetchBlocked({ reason: "source exceeds the import byte ceiling" });
        }

        return { bytes, contentType, sourceUrl: gated.url.toString() };
      };

      return follow(rawUrl, 0);
    },
    catch: (cause) =>
      cause instanceof PhotoImportFetchBlocked
        ? cause
        : new PhotoImportFetchBlocked({
            reason:
              cause instanceof DOMException && cause.name === "AbortError"
                ? "source fetch timed out"
                : "source fetch failed",
          }),
  });

export type PhotoImportScope =
  | { readonly scope: "venue"; readonly venueId: string }
  | {
      readonly scope: "dish";
      readonly venueId: string;
      readonly dishId: string;
      /** Existing dish-media row id read via dish-media-service read paths. */
      readonly dishEvidenceMediaId: string;
    };

/**
 * Scope decision, pure: dish association only when the caller supplies
 * both a dish id and an evidence media id previously verified through
 * existing dish-media-service read paths (find/admin-list/published
 * lookups confirming the candidate depicts that dish). Anything else —
 * including a bare dish id — stays venue-scoped, and the dish link (if
 * any) is later made by staff through the dish-media pipeline.
 */
export const resolvePhotoScope = (input: {
  readonly venueId: string;
  readonly dishId: string | null;
  readonly dishEvidenceMediaId: string | null;
}): PhotoImportScope => {
  const venueId = input.venueId.trim();
  const dishId = trimmedOrNull(input.dishId);
  const evidence = trimmedOrNull(input.dishEvidenceMediaId);

  if (dishId !== null && evidence !== null) {
    return { scope: "dish", venueId, dishId, dishEvidenceMediaId: evidence };
  }

  return { scope: "venue", venueId };
};

export interface PrepareRemoteImportInput {
  readonly venueId: string;
  readonly imageUrl: string;
  readonly rights: PhotoRightsCandidate;
  readonly dishId: string | null;
  readonly dishEvidenceMediaId: string | null;
  readonly altText: string | null;
  /** Test seam; production callers omit it and use the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface PreparedRemoteImport {
  readonly venueId: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly altText: string | null;
  readonly attribution: string;
  readonly license: ImportablePhotoLicense;
  /** Final post-redirect URL: the provenance recorded downstream. */
  readonly sourceUrl: string;
  readonly scope: PhotoImportScope;
  readonly shareAlike: boolean;
}

export interface StagingInput {
  readonly venueId: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly altText: string | null;
  readonly attribution: string;
  readonly license: string;
  readonly focalX: null;
  readonly focalY: null;
  readonly sourceUrl: string;
  readonly makePrimary: false;
}

/**
 * Coordinator contract for `prepareRemoteImport`: staff-only Effect with
 * typed failures. Feed success through `toStagingInput` into the
 * existing `RestaurantPhotoService.stagePhoto`, then `submitForReview`.
 */
export type PrepareRemoteImportDeps = Database | RoleRepository | CurrentActor | Authorization;

export type PrepareRemoteImportFailures =
  | PhotoImportRightsBlocked
  | PhotoImportFetchBlocked
  | InsufficientPermissions
  | DatabaseError;

/**
 * Staff-gated import preparation: `restaurant:manage` authorization, then
 * rights gate → SSRF-safe fetch → scope decision. Returns first-party
 * staging input; the coordinator feeds it to the existing
 * `RestaurantPhotoService.stagePhoto` (which re-validates bytes, venue,
 * and caps) and on to `submitForReview`. Never hotlinks: downstream
 * delivery always resolves to stored derivatives.
 */
export const prepareRemoteImport = Effect.fn("restaurant-photo-import/prepare")(function* (
  input: PrepareRemoteImportInput,
) {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;

  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

  const rights = yield* checkPhotoRights(input.rights);
  const fetched = yield* fetchImportBytes(input.imageUrl, input.fetchImpl, input.timeoutMs);

  const scope = resolvePhotoScope({
    venueId: input.venueId,
    dishId: input.dishId,
    dishEvidenceMediaId: input.dishEvidenceMediaId,
  });

  const prepared: PreparedRemoteImport = {
    venueId: input.venueId.trim(),
    bytes: fetched.bytes,
    filename: filenameForContentType(fetched.contentType),
    contentType: fetched.contentType,
    altText: trimmedOrNull(input.altText),
    attribution: buildImportAttribution({ ...rights, sourceUrl: fetched.sourceUrl }),
    license: rights.license,
    sourceUrl: fetched.sourceUrl,
    scope,
    shareAlike: rights.shareAlike,
  };

  return prepared;
});

/**
 * Shape adapter for the existing staging pipeline: the coordinator passes
 * the result straight into `RestaurantPhotoService.stagePhoto`. Imports
 * never become primary on arrival — curators set order at review.
 * `focalX`/`focalY` stay null until staff set them at Review image.
 */
export const toStagingInput = (prepared: PreparedRemoteImport): StagingInput => ({
  venueId: prepared.venueId,
  bytes: prepared.bytes,
  filename: prepared.filename,
  altText: prepared.altText,
  attribution: prepared.attribution,
  license: prepared.license,
  focalX: null,
  focalY: null,
  sourceUrl: prepared.sourceUrl,
  makePrimary: false,
});

export const SUPPORTED_LICENSES_NOTE =
  `Remote import accepts ${IMPORTABLE_PHOTO_LICENSES.join(", ")} ` +
  `(a read-only subset of ${SUPPORTED_PHOTO_LICENSES.join(", ")}).`;
