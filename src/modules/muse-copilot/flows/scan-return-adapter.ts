import { z } from "zod";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import { MenuScanClientError } from "@/modules/restaurant-discovery/menu-scan-client";
import type { Locale } from "@/shared/i18n";

const uuidSchema = z.uuid();

/** Catch-site narrowing for scanner transport failures (value use site). */
export const isScanClientError = (error: unknown): error is MenuScanClientError =>
  error instanceof MenuScanClientError;

/**
 * Owned scan id carried back into Muse. UUID shape only — never ownership
 * material: the server re-verifies ownership, privacy, and expiry on every
 * copilot call, so a shared or stale link grants nothing.
 */
export const ownedScanIdFrom = (scanId: string | undefined): string | null => {
  if (scanId === undefined) {
    return null;
  }

  const parsed = uuidSchema.safeParse(scanId);

  return parsed.success ? parsed.data : null;
};

export interface ScanEntrySearch {
  readonly lang: Locale;
  readonly venueId?: string | undefined;
  readonly returnVenue?: string | undefined;
  readonly returnView: "copilot";
}

/**
 * Direct scanner entry (plan §15): locale plus validated venue scope and the
 * Muse return context. No intermediate scanner form lives in Muse — the
 * canonical `/scan` route owns capture, validation, and extraction.
 */
export const scanEntrySearch = (language: Locale, venueId: string | undefined): ScanEntrySearch => {
  const parsed = venueId === undefined ? null : uuidSchema.safeParse(venueId);

  if (parsed !== null && parsed.success) {
    return {
      lang: language,
      venueId: parsed.data,
      returnVenue: parsed.data,
      returnView: "copilot",
    };
  }

  return { lang: language, returnView: "copilot" };
};

/**
 * Actionable return-scan errors, mapped from the scanner transport boundary
 * before any re-upload (plan §§15/18, addendum §7). Revision numbers and
 * raw payloads never reach Muse UI — only the recovery guidance. Callers
 * narrow the caught value with `instanceof` at the catch site and fall back
 * to `copy.errorUnavailable` for anything else.
 */
export const scanStatusText = (copy: CopilotCopy, error: MenuScanClientError): string => {
  const kind = error.transportKind;

  if (kind === "not-found") {
    return copy.errorExpiredScan;
  }

  if (kind === "unauthorized") {
    return copy.errorUnauthorizedScan;
  }

  if (kind === "rate-limited") {
    return copy.errorRateLimited;
  }

  if (kind === "transport-unavailable" || kind === "too-slow") {
    return copy.errorTransport;
  }

  return copy.errorUnavailable;
};
