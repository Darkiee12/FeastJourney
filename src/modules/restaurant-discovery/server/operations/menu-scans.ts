import { createHash, randomUUID } from "node:crypto";

import { Data, Effect, Exit, Option } from "effect";
import { type z } from "zod";

import { CatalogService, PlaceRepository } from "@/modules/food-discovery/server/index";
import {
  normalizeCurrencyContext,
  parsePlaceMenuCityId,
  resolveMenuCityId,
  type CurrencyContext,
} from "@/modules/restaurant-discovery/menu-price-evidence";
import {
  menuDocumentFitsStorage,
  validateMenuRevision,
} from "@/modules/restaurant-discovery/menu-scan-revision";
import {
  contributeScanSchema,
  createScanSchema,
  menuScanDocumentSchema,
  reviseScanSchema,
  type MenuScanDocument,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import confirmAsset from "@/modules/restaurant-discovery/server/repository/sql/scan-asset-confirm.sql";
import failAsset from "@/modules/restaurant-discovery/server/repository/sql/scan-asset-failed.sql";
import removeAsset from "@/modules/restaurant-discovery/server/repository/sql/scan-asset-removed.sql";
import reserveAsset from "@/modules/restaurant-discovery/server/repository/sql/scan-asset-reserve.sql";
import assetTotals from "@/modules/restaurant-discovery/server/repository/sql/scan-asset-totals.sql";
import assetsQuery from "@/modules/restaurant-discovery/server/repository/sql/scan-assets.sql";
import claimMember from "@/modules/restaurant-discovery/server/repository/sql/scan-claim-member.sql";
import claimExtraction from "@/modules/restaurant-discovery/server/repository/sql/scan-claim.sql";
import completeExtraction from "@/modules/restaurant-discovery/server/repository/sql/scan-complete.sql";
import contribute from "@/modules/restaurant-discovery/server/repository/sql/scan-contribute.sql";
import createScan from "@/modules/restaurant-discovery/server/repository/sql/scan-create.sql";
import contributionQuery from "@/modules/restaurant-discovery/server/repository/sql/scan-current-contribution.sql";
import deleteScan from "@/modules/restaurant-discovery/server/repository/sql/scan-delete.sql";
import extractionGuard from "@/modules/restaurant-discovery/server/repository/sql/scan-extraction-guard.sql";
import failExtraction from "@/modules/restaurant-discovery/server/repository/sql/scan-fail.sql";
import ownedScan from "@/modules/restaurant-discovery/server/repository/sql/scan-owned.sql";
import privateAssets from "@/modules/restaurant-discovery/server/repository/sql/scan-private-assets.sql";
import publicVenue from "@/modules/restaurant-discovery/server/repository/sql/scan-public-venue.sql";
import retainScan from "@/modules/restaurant-discovery/server/repository/sql/scan-retain.sql";
import reviseScan from "@/modules/restaurant-discovery/server/repository/sql/scan-revise.sql";
import insertRevision from "@/modules/restaurant-discovery/server/repository/sql/scan-revision-insert.sql";
import revisionQuery from "@/modules/restaurant-discovery/server/repository/sql/scan-revision.sql";
import { withTransaction } from "@/server/database/client";
import { runQuery } from "@/server/database/query";
import { menuScanConfig } from "@/server/integrations/menu-scan-config";
import {
  ExtractionUnavailable,
  InvalidModelOutput,
  MENU_SCAN_COMBINED_IMAGE_BYTES,
  MenuExtractor,
} from "@/server/integrations/muse-menu";
import {
  MAX_IMAGE_BYTES,
  PrivateMenuStorage,
  validateMenuImage,
} from "@/server/integrations/private-menu-storage";

/** Constructed only by the verified session/capability transport boundary. */
export interface ScanPrincipal {
  readonly userId: string | null;
  readonly guestHash: string;
}

export class ScanNotFound extends Data.TaggedError("ScanNotFound")<{}> {}

export class ScanConflict extends Data.TaggedError("ScanConflict")<{ readonly reason: string }> {}

export class ScanInputError extends Data.TaggedError("ScanInputError")<{
  readonly reason: string;
}> {}

/**
 * Resolve the operator's menu-scanner configuration with logging.
 * Disabled resolves to null (callers fail closed with "disabled"); an
 * invalid explicit configuration logs field + reason server-side (never
 * values) and fails as a provider outage at the transport boundary.
 */
export const resolveScannerOrFail = Effect.fn("menu.scannerConfig")(function* () {
  try {
    return menuScanConfig();
  } catch (error) {
    yield* Effect.logError("Menu scanner configuration invalid").pipe(
      Effect.annotateLogs({
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );

    return yield* new ExtractionUnavailable({
      reason: "Menu analysis is unavailable. Please retry later.",
      retryable: false,
      category: "unavailable",
    });
  }
});

/**
 * Upload caps for attachMenuPhoto. Derived from the operator's MENU_SCAN_*
 * configuration when the scanner resolves; historical defaults otherwise.
 */
export const resolveUploadCaps = () => {
  try {
    const scanner = menuScanConfig();

    if (scanner !== null) {
      return { maxImages: scanner.maxImages, maxImageBytes: scanner.maxImageBytes };
    }
  } catch {
    // Misconfigured scanner: fall back to defaults for uploads; extraction
    // itself fails loudly at its own boundary with field + reason.
  }

  return { maxImages: 6, maxImageBytes: MAX_IMAGE_BYTES };
};

export const requireOwnedMenuScan = Effect.fn("menu.requireOwned")(function* (
  principal: ScanPrincipal,
  scanId: string,
) {
  const scan = yield* runQuery("menu/owned", (sql) =>
    ownedScan.run(sql, {
      id: scanId,
      user_id: principal.userId,
      guest_hash: principal.guestHash,
    }),
  );

  if (scan === null) return yield* new ScanNotFound();

  return scan;
});

export const loadMenuScanDocument = Effect.fn("menu.loadRevision")(function* (
  scanId: string,
  revision: number,
) {
  const row = yield* runQuery("menu/revision", (sql) =>
    revisionQuery.run(sql, { session_id: scanId, revision }),
  );

  if (row === null) return yield* new ScanNotFound();

  // The versioned JSON document is an independent untrusted-data contract;
  // Reylo types the row but does not validate the JSON's schema version.
  // Origin/model travel alongside so the UI can attribute the revision
  // without a second query; they are display metadata, never authority.
  const parsed = yield* Effect.try({
    try: () => menuScanDocumentSchema.parse(row.document),
    catch: () => new ScanInputError({ reason: "The saved menu document could not be read." }),
  });

  return { document: parsed, origin: row.origin, model: row.model };
});

export const getMenuScan = Effect.fn("menu.get")(function* (
  principal: ScanPrincipal,
  scanId: string,
) {
  return yield* withTransaction(
    "menu/get",
    Effect.gen(function* () {
      const scan = yield* requireOwnedMenuScan(principal, scanId);

      const assets = yield* runQuery("menu/assets", (sql) =>
        assetsQuery.run(sql, { session_id: scanId }),
      );

      const contribution = yield* runQuery("menu/contribution", (sql) =>
        contributionQuery.run(sql, { session_id: scanId }),
      );

      const document =
        scan.current_revision === null
          ? null
          : yield* loadMenuScanDocument(scanId, scan.current_revision);

      const revision =
        scan.current_revision === null || document === null
          ? null
          : {
              number: scan.current_revision,
              origin: document.origin,
              model: document.model,
            };

      return {
        scan,
        assets,
        document: document === null ? null : document.document,
        revision,
        contribution,
      };
    }),
  );
});

export const createMenuScan = Effect.fn("menu.create")(function* (
  principal: ScanPrincipal,
  request: z.infer<typeof createScanSchema>,
) {
  const parsed = createScanSchema.safeParse(request);

  if (!parsed.success)
    return yield* new ScanInputError({
      reason: "Choose a supported language and restaurant branch.",
    });

  const venueId = parsed.data.venueId;

  if (venueId !== null) {
    const venue = yield* runQuery("menu/venue", (sql) => publicVenue.run(sql, { id: venueId }));

    if (venue === null)
      return yield* new ScanInputError({
        reason: "Choose a published restaurant branch or scan an unknown menu.",
      });
  }

  const result = yield* runQuery("menu/create", (sql) =>
    createScan.run(sql, {
      user_id: principal.userId,
      guest_hash: principal.userId === null ? principal.guestHash : null,
      venue_id: parsed.data.venueId,
      language: parsed.data.targetLanguage,
    }),
  );

  yield* Effect.logInfo("Menu scan created").pipe(Effect.annotateLogs({ scanId: result.id }));

  return result;
});

export const attachMenuPhoto = Effect.fn("menu.attachPhoto")(function* (
  principal: ScanPrincipal,
  scanId: string,
  pageNumber: number,
  bytes: Uint8Array,
  mediaType: string,
) {
  yield* withTransaction("menu/authorize-upload", requireOwnedMenuScan(principal, scanId));

  // Upload caps derive from the operator's MENU_SCAN_* configuration so an
  // explicit value is honored end to end. When the scanner is disabled or
  // misconfigured, uploads keep the historical defaults; extraction itself
  // still fails loudly at its own boundary. The 24 MiB combined bound stays
  // fixed: it is the provider's inline-payload transport limit, not an
  // operator ceiling (see MENU_SCAN_COMBINED_IMAGE_BYTES).
  const uploadCaps = resolveUploadCaps();

  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > uploadCaps.maxImages) {
    return yield* new ScanInputError({
      reason:
        uploadCaps.maxImages === 1
          ? "Menu pages must be numbered one."
          : `Menu pages must be numbered between one and ${uploadCaps.maxImages}.`,
    });
  }

  const image = yield* validateMenuImage(bytes, mediaType, uploadCaps.maxImageBytes);
  const key = `menu/${scanId}/${randomUUID()}`;

  const asset = yield* withTransaction(
    "menu/reserve-upload",
    Effect.gen(function* () {
      const scan = yield* requireOwnedMenuScan(principal, scanId);

      if (scan.current_revision !== null || scan.status === "processing")
        return yield* new ScanConflict({
          reason: "Photographs cannot change after analysis starts.",
        });

      const totals = yield* runQuery("menu/upload-totals", (sql) =>
        assetTotals.run(sql, { session_id: scanId }),
      );

      if (
        totals.count >= uploadCaps.maxImages ||
        (totals.bytes ?? 0) + image.byteLength > MENU_SCAN_COMBINED_IMAGE_BYTES
      )
        return yield* new ScanInputError({
          reason: `Use at most ${uploadCaps.maxImages} photographs and 24 MiB in total.`,
        });

      const existing = yield* runQuery("menu/upload-pages", (sql) =>
        assetsQuery.run(sql, { session_id: scanId }),
      );

      if (existing.some((entry) => entry.page_number === pageNumber))
        return yield* new ScanConflict({ reason: "This menu page is already attached." });

      return yield* runQuery("menu/reserve-asset", (sql) =>
        reserveAsset.run(sql, {
          session_id: scanId,
          key,
          page_number: pageNumber,
          bytes: image.byteLength,
        }),
      );
    }),
  );

  const storage = yield* PrivateMenuStorage;

  return yield* Effect.acquireUseRelease(
    Effect.succeed(asset),
    (reserved) =>
      Effect.gen(function* () {
        yield* storage.put(key, image.bytes);
        const stored = yield* storage.read(key, uploadCaps.maxImageBytes);

        if (
          stored.byteLength !== image.byteLength ||
          createHash("sha256").update(stored).digest("hex") !== image.checksum
        ) {
          return yield* new ScanInputError({
            reason: "The uploaded photograph could not be verified. Please retry.",
          });
        }

        return yield* withTransaction(
          "menu/confirm-upload",
          Effect.gen(function* () {
            const scan = yield* requireOwnedMenuScan(principal, scanId);

            if (scan.current_revision !== null || scan.status === "processing")
              return yield* new ScanConflict({
                reason: "The menu changed while the photograph uploaded.",
              });

            const confirmed = yield* runQuery("menu/confirm-asset", (sql) =>
              confirmAsset.run(sql, {
                id: reserved.id,
                media_type: image.mediaType,
                bytes: image.byteLength,
                width: image.width,
                height: image.height,
                checksum: image.checksum,
              }),
            );

            if (confirmed === null)
              return yield* new ScanConflict({ reason: "The upload is no longer pending." });

            return { assetId: confirmed.id, pageNumber };
          }),
        );
      }),
    (reserved, exit) => {
      if (Exit.isSuccess(exit)) return Effect.void;

      // The committed reservation survives database/storage failure. Failed
      // removal remains tracked and is retried by the retention cleanup job.
      return Effect.gen(function* () {
        yield* runQuery("menu/mark-failed-upload", (sql) =>
          failAsset.run(sql, { id: reserved.id, session_id: scanId }),
        );
        yield* storage.remove(key);
        yield* runQuery("menu/removed-upload", (sql) =>
          removeAsset.run(sql, { id: reserved.id, session_id: scanId }),
        );
      }).pipe(Effect.catch(() => Effect.logWarning("Menu upload cleanup requires retry")));
    },
  );
});

export const readMenuPhoto = Effect.fn("menu.readPhoto")(function* (
  principal: ScanPrincipal,
  scanId: string,
  assetId: string,
) {
  const asset = yield* withTransaction(
    "menu/authorize-photo",
    Effect.gen(function* () {
      yield* requireOwnedMenuScan(principal, scanId);

      const assets = yield* runQuery("menu/private-assets", (sql) =>
        privateAssets.run(sql, { session_id: scanId }),
      );

      const selected = assets.find((entry) => entry.id === assetId);

      if (selected === undefined) return yield* new ScanNotFound();

      return selected;
    }),
  );

  const storage = yield* PrivateMenuStorage;

  return yield* storage.read(asset.object_key, resolveUploadCaps().maxImageBytes);
});

interface PlaceMenuEvidence {
  readonly menuCity: string | null;
  readonly menuCountry: string | null;
}

const noPlaceMenuEvidence: PlaceMenuEvidence = { menuCity: null, menuCountry: null };

const COUNTRY_ISO = /^[A-Z]{2}$/;

/**
 * Resolve a `place:<decimalId>` menu city id to coarse currency evidence
 * through the place catalog: the locale-picked display name becomes the
 * visitor-indicated city and the nearest country-kind ancestor ISO becomes
 * the visitor-indicated country. Only city-scale kinds (locality,
 * subnational, province) yield a city; country records contribute their
 * ISO only; regions and continents are dropped. Unknown or missing records
 * degrade to null — never trusted as geography. Non-place ids return null
 * so the caller falls back to the sync preset/`geo:` resolver. The catalog
 * services are read optionally: runtimes without them (minimal test
 * harnesses) degrade to null, while the production runtime always provides
 * them. No raw GPS,
 * street addresses, or coordinates leave this boundary; the locale only
 * picks the display label language, never location.
 */
const resolvePlaceIdMenuEvidence = Effect.fn("menu.resolvePlaceIdEvidence")(function* (
  menuCityId: string | null | undefined,
  locale: string,
) {
  const placeId = parsePlaceMenuCityId(menuCityId);

  if (placeId === null) return noPlaceMenuEvidence;

  const catalogOption = yield* Effect.serviceOption(CatalogService);
  const placesOption = yield* Effect.serviceOption(PlaceRepository);

  if (Option.isNone(catalogOption) || Option.isNone(placesOption)) return noPlaceMenuEvidence;

  const catalog = catalogOption.value;
  const places = placesOption.value;

  const detail = yield* catalog
    .getPlace(placeId, locale)
    .pipe(Effect.catchTag("PlaceNotFound", () => Effect.succeed(null)));

  if (detail === null) return noPlaceMenuEvidence;

  if (detail.kind !== "locality" && detail.kind !== "subnational" && detail.kind !== "province") {
    if (detail.kind === "country" && detail.iso3166 !== null && COUNTRY_ISO.test(detail.iso3166)) {
      const countryOnly: PlaceMenuEvidence = { menuCity: null, menuCountry: detail.iso3166 };

      return countryOnly;
    }

    return noPlaceMenuEvidence;
  }

  const chain = yield* places.ancestors(BigInt(placeId));

  let menuCountry: string | null = null;

  for (const entry of chain) {
    if (entry.kind === "country" && entry.iso3166 !== null && COUNTRY_ISO.test(entry.iso3166)) {
      menuCountry = entry.iso3166;
      break;
    }
  }

  const evidence: PlaceMenuEvidence = { menuCity: detail.displayName ?? null, menuCountry };

  return evidence;
});

/**
 * Resolve a curated preset or `geo:` display name to coarse currency
 * evidence through the place catalog search (`searchCities`, which resolves
 * aliases like "Bangalore" through place_names). Presets carry no country
 * of their own — the top city-scale hit supplies the country ISO, so no
 * preset-to-country map lives anywhere. Unmatched names keep their city
 * text with no country; lookup failures (bad locale, catalog outage)
 * degrade to the same city-only evidence so a weak hint never fails an
 * extraction. The hit is a nearest-name match, weaker than a `place:`
 * registry identity; genuine ambiguity stays visible because the evidence
 * sentence names the city and country together.
 */
const resolveNamedMenuEvidence = Effect.fn("menu.resolveNamedEvidence")(function* (
  displayName: string,
  locale: string,
) {
  const cityOnly: PlaceMenuEvidence = { menuCity: displayName, menuCountry: null };

  const catalogOption = yield* Effect.serviceOption(CatalogService);

  if (Option.isNone(catalogOption)) return cityOnly;

  const cities = yield* catalogOption.value
    .searchCities(displayName, locale, 1)
    .pipe(Effect.orElseSucceed(() => [] as const));

  const first = cities[0];

  if (first === undefined) return cityOnly;

  const evidence: PlaceMenuEvidence = {
    menuCity: first.name ?? displayName,
    menuCountry: first.country !== null && COUNTRY_ISO.test(first.country) ? first.country : null,
  };

  return evidence;
});

/**
 * Resolve a client-supplied menu city id to coarse currency evidence.
 * `place:<decimalId>` identities resolve through the place registry;
 * curated preset ids ("hcmc" | "hanoi" | "bangalore") and `geo:` names
 * resolve through the catalog city search to a display name plus country
 * ISO. Anything else is dropped: the client is never trusted to assert
 * geography with an arbitrary string.
 */
const resolvePlaceMenuEvidence = Effect.fn("menu.resolvePlaceEvidence")(function* (
  menuCityId: string | null | undefined,
  locale: string,
) {
  const placeId = parsePlaceMenuCityId(menuCityId);

  if (placeId !== null) return yield* resolvePlaceIdMenuEvidence(menuCityId, locale);

  const displayName = resolveMenuCityId(menuCityId);

  if (displayName === null) return noPlaceMenuEvidence;

  return yield* resolveNamedMenuEvidence(displayName, locale);
});

/**
 * Orchestration margin (seconds) added to the operator's MENU_SCAN_TIMEOUT_MS
 * when sizing the extraction lease. Covers asset reads, document assembly
 * and revision writes around the provider call, plus clock slack. A fixed
 * technical margin, documented here — not an operator ceiling and not a
 * bound on the provider budget itself.
 */
const MENU_EXTRACTION_LEASE_MARGIN_S = 120;

export const extractMenu = Effect.fn("menu.extractScan")(function* (
  principal: ScanPrincipal,
  scanId: string,
  requestId: string,
  location?: { readonly trustedCountry?: string | null; readonly menuCityId?: string | null },
) {
  // Revision provenance records the actual configured model, so resolve it
  // before any lease or inference. A disabled or misconfigured scanner fails
  // here; the live extractor enforces the same boundary before any provider call.
  const scanner = yield* resolveScannerOrFail();

  if (scanner === null)
    return yield* new ExtractionUnavailable({
      reason: "Menu analysis is unavailable. Please retry later.",
      retryable: false,
      category: "unavailable",
    });

  // Mask only the lease-to-worker handoff: cancellation must not leave a
  // committed lease without a worker. Provider work remains interruptible.
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const token = yield* withTransaction(
        "menu/claim-extraction",
        Effect.gen(function* () {
          const scan = yield* requireOwnedMenuScan(principal, scanId);

          if (scan.current_revision !== null) return null;

          const assets = yield* runQuery("menu/required-assets", (sql) =>
            assetsQuery.run(sql, { session_id: scanId }),
          );

          if (assets.length === 0 || assets.some((asset) => asset.status !== "ready"))
            return yield* new ScanConflict({
              reason: "Wait for every menu photograph to finish uploading.",
            });

          yield* runQuery("menu/extraction-guard", (sql) => extractionGuard.run(sql));
          const lease = randomUUID();

          // Lease lifetime derives from the operator's provider budget plus a
          // documented orchestration margin (asset reads, revision writes,
          // clock slack) — never a fixed 90 seconds. attempts/concurrency caps
          // stay in SQL: they are abuse/resource protections for this
          // guest-accessible endpoint, not operator ceilings.
          const leaseSeconds = Math.ceil(scanner.timeoutMs / 1000) + MENU_EXTRACTION_LEASE_MARGIN_S;

          const claimed = yield* runQuery("menu/claim-extraction", (sql) =>
            claimExtraction.run(sql, { id: scanId, token: lease, lease_seconds: leaseSeconds }),
          );

          if (claimed === null) {
            // The owned row is locked throughout this transaction. An active
            // lease cannot be claimed again; return its view for polling instead.
            // Expired leases still pass through the SQL retry/concurrency guards.
            if (scan.status === "processing") return null;

            return yield* new ScanConflict({
              reason:
                "The analysis retry or concurrency limit was reached. Please try again later.",
            });
          }

          return lease;
        }),
      );

      if (token === null) return;

      // Async extraction: the lease claim above is the only request-bound work.
      // The provider call runs detached so no HTTP/server-function/proxy budget
      // bounds it — only MENU_SCAN_TIMEOUT_MS does, whatever the operator sets.
      // The client polls getMenuScan until the document lands or the scan fails;
      // a retry while processing returns the current view without another worker.
      // Lease expiry plus the attempt/concurrency caps
      // in scan-claim.sql recover crashed or abandoned runs for retry.
      const runExtraction = Effect.acquireUseRelease(
        Effect.succeed(token),
        (lease) =>
          Effect.gen(function* () {
            const state = yield* getMenuScan(principal, scanId);

            const assets = yield* runQuery("menu/extraction-assets", (sql) =>
              privateAssets.run(sql, { session_id: scanId }),
            );

            const storage = yield* PrivateMenuStorage;

            const images = yield* Effect.forEach(
              assets,
              (asset) =>
                Effect.gen(function* () {
                  const bytes = yield* storage.read(asset.object_key, scanner.maxImageBytes);

                  if (
                    asset.media_type === null ||
                    asset.checksum === null ||
                    asset.byte_length !== bytes.byteLength ||
                    createHash("sha256").update(bytes).digest("hex") !== asset.checksum
                  ) {
                    return yield* new ScanInputError({
                      reason: "A menu photograph could not be verified. Please upload it again.",
                    });
                  }

                  return { assetId: asset.id, bytes, mediaType: asset.media_type };
                }),
              { concurrency: 2 },
            );

            const extractor = yield* MenuExtractor;

            // Currency context merges existing scan fields only: the linked
            // venue (venue_id/venue_name already on the scan row) outranks the
            // coarse visitor country. The visitor-selected menu city id resolves
            // server-side: `place:` registry ids resolve through the place
            // catalog to a coarse city display name plus country ISO
            // (unknown/missing records degrade to null), while curated
            // presets and `geo:` names resolve through the catalog city
            // search to a display name plus country ISO (unmatched names
            // keep their city text with no country, never invented
            // geography). No new persistence, no raw GPS or
            // street addresses, and language is never treated as location.
            const targetLanguage = menuScanDocumentSchema.shape.targetLanguage.parse(
              state.scan.target_language,
            );

            const placeEvidence = yield* resolvePlaceMenuEvidence(
              location?.menuCityId ?? null,
              targetLanguage,
            );

            const currencyContext: CurrencyContext = normalizeCurrencyContext({
              venueName: state.scan.venue_name,
              menuCity: placeEvidence.menuCity,
              menuCountry: placeEvidence.menuCountry,
              trustedCountry: location?.trustedCountry ?? null,
            });

            const extraction = yield* extractor.extract({
              images,
              targetLanguage,
              requestId,
              currencyContext,
            });

            const document: MenuScanDocument = {
              ...extraction,
              schemaVersion: 1,
              targetLanguage: menuScanDocumentSchema.shape.targetLanguage.parse(
                state.scan.target_language,
              ),
              pages: assets.map((asset) => ({ assetId: asset.id, pageNumber: asset.page_number })),
              items: extraction.items.map((item) =>
                Object.assign({}, item, {
                  id: randomUUID(),
                  variants: item.variants.map((variant) =>
                    Object.assign({}, variant, { id: randomUUID() }),
                  ),
                }),
              ),
            };

            if (!menuDocumentFitsStorage(document)) {
              return yield* new InvalidModelOutput({
                reason: "The extracted menu is too large. Retry with fewer pages.",
                retryable: false,
                category: "truncated",
              });
            }

            yield* withTransaction(
              "menu/complete-extraction",
              Effect.gen(function* () {
                yield* requireOwnedMenuScan(principal, scanId);

                const complete = yield* runQuery("menu/complete-extraction", (sql) =>
                  completeExtraction.run(sql, { id: scanId, token: lease }),
                );

                if (complete === null) {
                  yield* new ScanConflict({
                    reason: "The analysis lease expired. Please retry.",
                  });
                }

                yield* runQuery("menu/model-revision", (sql) =>
                  insertRevision.run(sql, {
                    session_id: scanId,
                    revision: 1,
                    document,
                    origin: "model",
                    model: scanner.model,
                    user_id: principal.userId,
                  }),
                );
              }),
            );

            return yield* getMenuScan(principal, scanId);
          }),
        (held, exit) => {
          // Success already completed the session; only a failed or interrupted
          // extraction releases the lease for expiry or retry. Matches
          // attachMenuPhoto, which also skips cleanup on success. requestId is
          // in scope: a worker interruption is
          // observable as this log line, distinct from a provider timeout
          // failure logged by the extractor itself.
          if (Exit.isSuccess(exit)) return Effect.void;

          return Effect.gen(function* () {
            yield* Effect.logWarning("Menu extraction lease released after failure").pipe(
              Effect.annotateLogs({ requestId, scanId }),
            );

            yield* runQuery("menu/release-extraction", (sql) =>
              failExtraction.run(sql, { id: scanId, token: held }),
            ).pipe(
              Effect.catch(() => Effect.logWarning("Menu analysis lease release requires expiry")),
            );
          });
        },
      );

      yield* Effect.forkDetach(
        Effect.gen(function* () {
          // Own a fresh scope rather than retaining the request's resource scope.
          // forkDetach inherits provider/config services and outlives the request.
          const outcome = yield* Effect.exit(Effect.scoped(runExtraction));

          if (Exit.isFailure(outcome)) {
            yield* Effect.logError("Menu extraction background run failed").pipe(
              Effect.annotateLogs({ requestId, scanId }),
            );
          }
        }),
        { uninterruptible: false },
      );
    }),
  );

  // No provider wait in the HTTP request. Fast workers may already have
  // completed; otherwise the client receives processing and starts polling.
  return yield* getMenuScan(principal, scanId);
});

/**
 * Corrections retain server-owned identities and page provenance, but may
 * repair AI omissions: items and variants can be added (flagged
 * customerAdded) or removed. Counts are no longer frozen.
 */

export const reviseMenuScan = Effect.fn("menu.revise")(function* (
  principal: ScanPrincipal,
  request: z.infer<typeof reviseScanSchema>,
) {
  const parsed = reviseScanSchema.safeParse(request);

  if (!parsed.success)
    return yield* new ScanInputError({ reason: "The corrected menu contains invalid values." });

  const input = parsed.data;
  yield* withTransaction(
    "menu/revise",
    Effect.gen(function* () {
      const scan = yield* requireOwnedMenuScan(principal, input.scanId);

      if (scan.status !== "complete" || scan.current_revision !== input.expectedRevision) {
        yield* new ScanConflict({
          reason: "The menu changed. Reload it before saving corrections.",
        });
      }

      const previous = yield* loadMenuScanDocument(input.scanId, input.expectedRevision);

      if (!validateMenuRevision(previous.document, input.document)) {
        yield* new ScanInputError({
          reason: "Corrections must retain the original menu items, variants and photographs.",
        });
      }

      const previousItems = new Map(previous.document.items.map((item) => [item.id, item]));

      const document = {
        ...input.document,
        items: input.document.items.map((item) => {
          const existing = previousItems.get(item.id);
          const existingVariants = new Set(existing?.variants.map((variant) => variant.id) ?? []);

          return {
            ...item,
            id: existing === undefined ? randomUUID() : item.id,
            variants: item.variants.map((variant) => ({
              ...variant,
              id: existingVariants.has(variant.id) ? variant.id : randomUUID(),
            })),
          };
        }),
      };

      if (!menuDocumentFitsStorage(document)) {
        yield* new ScanInputError({ reason: "The corrected menu is too large to save." });
      }

      const revision = input.expectedRevision + 1;
      yield* runQuery("menu/customer-revision", (sql) =>
        insertRevision.run(sql, {
          session_id: input.scanId,
          revision,
          document,
          origin: "customer",
          model: null,
          user_id: principal.userId,
        }),
      );
      yield* runQuery("menu/current-revision", (sql) =>
        reviseScan.run(sql, { id: input.scanId, revision }),
      );
    }),
  );

  return yield* getMenuScan(principal, input.scanId);
});

export const submitMenuContribution = Effect.fn("menu.contribute")(function* (
  principal: ScanPrincipal,
  request: z.infer<typeof contributeScanSchema>,
) {
  const parsed = contributeScanSchema.safeParse(request);

  if (!parsed.success)
    return yield* new ScanInputError({
      reason:
        "Contribution requires explicit consent to the current terms and a saved menu revision.",
    });

  const input = parsed.data;

  return yield* withTransaction(
    "menu/contribute",
    Effect.gen(function* () {
      const scan = yield* requireOwnedMenuScan(principal, input.scanId);

      if (scan.status !== "complete" || scan.current_revision !== input.revision)
        return yield* new ScanConflict({
          reason: "Save and review the latest menu before contributing.",
        });

      const requestedVenue = input.venueId;

      if (requestedVenue !== null) {
        const venue = yield* runQuery("menu/contribution-venue", (sql) =>
          publicVenue.run(sql, { id: requestedVenue }),
        );

        if (venue === null)
          return yield* new ScanInputError({
            reason: "Choose an existing public branch or leave the branch unresolved.",
          });
      }

      const submitted = yield* runQuery("menu/submit-contribution", (sql) =>
        contribute.run(sql, {
          session_id: input.scanId,
          revision: input.revision,
          submitted_revision: input.revision,
          venue_id: input.venueId,
        }),
      );

      yield* runQuery("menu/retain-contribution", (sql) =>
        retainScan.run(sql, { id: input.scanId }),
      );

      return submitted;
    }),
  );
});

export const claimGuestMenuScan = Effect.fn("menu.claimGuest")(function* (
  principal: ScanPrincipal,
  scanId: string,
) {
  if (principal.userId === null)
    return yield* new ScanInputError({
      reason: "Sign in before saving this private scan to your account.",
    });

  const userId = principal.userId;

  const claimed = yield* runQuery("menu/claim-member", (sql) =>
    claimMember.run(sql, { id: scanId, user_id: userId, guest_hash: principal.guestHash }),
  );

  if (claimed === null) {
    // Repeating a successful claim is safe for its verified owner only.
    yield* withTransaction("menu/repeated-claim", requireOwnedMenuScan(principal, scanId));
  }

  return yield* getMenuScan(principal, scanId);
});

export const deleteMenuScan = Effect.fn("menu.delete")(function* (
  principal: ScanPrincipal,
  scanId: string,
) {
  yield* withTransaction(
    "menu/delete",
    Effect.gen(function* () {
      yield* requireOwnedMenuScan(principal, scanId);
      yield* runQuery("menu/mark-deleting", (sql) => deleteScan.run(sql, { id: scanId }));
    }),
  );

  return { deleted: true as const };
});

export { validateMenuRevision } from "@/modules/restaurant-discovery/menu-scan-revision";
