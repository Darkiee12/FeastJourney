import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { type z } from "zod";

import { scanReviewSchema } from "@/modules/restaurant-discovery/menu-scan.schema";
import { type MenuImport } from "@/modules/restaurant-discovery/restaurant.schema";
import {
  importMenu,
  reviewObservation,
  setMenuStatus,
  setOfferingStatus,
} from "@/modules/restaurant-discovery/server/operations/admin";
import {
  loadMenuScanDocument,
  resolveUploadCaps,
  ScanConflict,
  ScanInputError,
  ScanNotFound,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import assetsQuery from "@/modules/restaurant-discovery/server/repository/sql/scan-assets.sql";
import contributionDuplicates from "@/modules/restaurant-discovery/server/repository/sql/scan-contribution-duplicates.sql";
import contributionLock from "@/modules/restaurant-discovery/server/repository/sql/scan-contribution-lock.sql";
import promotionMenu from "@/modules/restaurant-discovery/server/repository/sql/scan-contribution-menu-insert.sql";
import contributionMenus from "@/modules/restaurant-discovery/server/repository/sql/scan-contribution-menus.sql";
import contributionsQuery from "@/modules/restaurant-discovery/server/repository/sql/scan-contributions.sql";
import privateAssets from "@/modules/restaurant-discovery/server/repository/sql/scan-private-assets.sql";
import priorPromotion from "@/modules/restaurant-discovery/server/repository/sql/scan-promoted.sql";
import publicVenue from "@/modules/restaurant-discovery/server/repository/sql/scan-public-venue.sql";
import reviewContribution from "@/modules/restaurant-discovery/server/repository/sql/scan-review.sql";
import { Authorization, recordAuditEvent } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { withTransaction } from "@/server/database/client";
import { runQuery } from "@/server/database/query";
import { PrivateMenuStorage } from "@/server/integrations/private-menu-storage";

const authorizeReview = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage", "review"] });

  return yield* Actor.$match(actor, {
    Guest: () =>
      Effect.fail(
        new ScanInputError({ reason: "Sign in with permission to review menu contributions." }),
      ),
    Member: ({ userId }) => Effect.succeed(userId),
  });
});

const requireContribution = Effect.fn("menu.requireContribution")(function* (id: string) {
  const row = yield* runQuery("menu/contribution-lock", (sql) => contributionLock.run(sql, { id }));

  if (row === null) return yield* new ScanNotFound();

  return row;
});

export const listMenuContributions = () =>
  Effect.gen(function* () {
    yield* authorizeReview;

    return yield* runQuery("menu/contribution-queue", (sql) => contributionsQuery.run(sql));
  });

export const getMenuContribution = Effect.fn("menu.getContribution")(function* (id: string) {
  yield* authorizeReview;

  return yield* withTransaction(
    "menu/contribution-detail",
    Effect.gen(function* () {
      const contribution = yield* requireContribution(id);

      const assets = yield* runQuery("menu/contribution-assets", (sql) =>
        assetsQuery.run(sql, { session_id: contribution.session_id }),
      );

      const { document } = yield* loadMenuScanDocument(
        contribution.session_id,
        contribution.revision,
      );

      const menus = yield* runQuery("menu/contribution-menus", (sql) =>
        contributionMenus.run(sql, { id: contribution.id }),
      );

      const duplicates = yield* runQuery("menu/contribution-duplicates", (sql) =>
        contributionDuplicates.run(sql, { session_id: contribution.session_id }),
      );

      return { contribution, assets, document, menus, duplicates };
    }),
  );
});

export const readContributionAsset = Effect.fn("menu.readContributionAsset")(function* (
  id: string,
  assetId: string,
) {
  yield* authorizeReview;

  const asset = yield* withTransaction(
    "menu/contribution-photo",
    Effect.gen(function* () {
      const contribution = yield* requireContribution(id);

      const assets = yield* runQuery("menu/contribution-private-assets", (sql) =>
        privateAssets.run(sql, { session_id: contribution.session_id }),
      );

      const selected = assets.find((entry) => entry.id === assetId);

      if (selected === undefined) return yield* new ScanNotFound();

      return selected;
    }),
  );

  const storage = yield* PrivateMenuStorage;

  return yield* storage.read(asset.object_key, resolveUploadCaps().maxImageBytes);
});

export const reviewMenuContribution = Effect.fn("menu.reviewContribution")(function* (
  request: z.infer<typeof scanReviewSchema>,
) {
  const actorId = yield* authorizeReview;
  const parsed = scanReviewSchema.safeParse(request);

  if (!parsed.success)
    return yield* new ScanInputError({
      reason: "Review the branch, observation dates, selected facts and notes before deciding.",
    });

  const input = parsed.data;

  return yield* withTransaction(
    "menu/review-contribution",
    Effect.gen(function* () {
      const contribution = yield* requireContribution(input.contributionId);

      if (contribution.status !== "pending") {
        if (contribution.status !== input.decision)
          return yield* new ScanConflict({
            reason: "Another reviewer already made a different decision.",
          });

        return {
          id: contribution.id,
          status: contribution.status,
          promoted_menu_id: contribution.promoted_menu_id,
        };
      }

      let menuId: string | null = null;

      if (input.decision === "approved") {
        if (
          input.venueId === null ||
          input.itemIds.length === 0 ||
          input.channel === null ||
          !input.rightsReviewed
        )
          return yield* new ScanInputError({
            reason:
              "Approval requires a confirmed branch, sales channel, private-evidence rights review and at least one reviewed item.",
          });

        const venueId = input.venueId;

        const venue = yield* runQuery("menu/review-venue", (sql) =>
          publicVenue.run(sql, { id: venueId }),
        );

        if (venue === null)
          return yield* new ScanInputError({
            reason: "Choose an existing public restaurant branch.",
          });

        const previous = yield* runQuery("menu/prior-promotion", (sql) =>
          priorPromotion.run(sql, { session_id: contribution.session_id }),
        );

        if (previous !== null)
          return yield* new ScanConflict({
            reason:
              "This scan already has a promoted menu. Add updates through the curated observation workflow.",
          });

        const observedAt = Date.parse(input.observedAt);
        const validUntil = Date.parse(input.validUntil);

        if (
          observedAt > Date.now() ||
          validUntil <= observedAt ||
          validUntil > observedAt + 365 * 86400000 ||
          validUntil > Date.parse(contribution.retention_until)
        )
          return yield* new ScanInputError({
            reason:
              "Observation dates must be in the past and the review horizon must end before private evidence expires.",
          });

        const { document } = yield* loadMenuScanDocument(
          contribution.session_id,
          contribution.revision,
        );

        const assets = yield* runQuery("menu/promotion-assets", (sql) =>
          privateAssets.run(sql, { session_id: contribution.session_id }),
        );

        if (assets.length === 0)
          return yield* new ScanInputError({
            reason: "Original private photographs are required for review.",
          });

        const selectedItems = new Set(input.itemIds);
        const selectedPrices = new Set(input.pricedVariantIds);

        if (
          selectedItems.size !== input.itemIds.length ||
          selectedPrices.size !== input.pricedVariantIds.length
        )
          return yield* new ScanInputError({
            reason: "Each reviewed item or price may be selected only once.",
          });

        const byAssetId = new Map(assets.map((asset) => [asset.id, asset]));

        // Group approved items by the first page that supports them, so each
        // promoted menu's source photograph is the page its items came from.
        const groups = new Map<string, MenuImport["items"]>();
        const supportingAssets = new Map<string, Set<string>>();
        const foundItems = new Set<string>();
        const foundPrices = new Set<string>();

        for (const item of document.items) {
          if (!selectedItems.has(item.id)) continue;

          if (item.sourceReferences.length === 0)
            return yield* new ScanInputError({
              reason: "A selected item has missing private source evidence.",
            });

          const primary = item.sourceReferences[0];

          if (
            primary === undefined ||
            item.sourceReferences.some((reference) => !byAssetId.has(reference.assetId))
          )
            return yield* new ScanInputError({
              reason: "A selected item has missing private source evidence.",
            });

          foundItems.add(item.id);
          const variants: MenuImport["items"][number]["variants"] = [];

          for (const variant of item.variants) {
            const price = variant.price;
            let reviewedPrice: MenuImport["items"][number]["variants"][number]["price"];

            if (selectedPrices.has(variant.id)) {
              if (price === null || price.amount === null || price.currency === null)
                return yield* new ScanInputError({
                  reason: "A reviewed price needs a readable original amount and currency.",
                });

              reviewedPrice = {
                amount: price.amount,
                rawText: price.rawText,
                currency: price.currency,
                kind: "listed",
                channel: input.channel,
                taxTreatment: price.taxTreatment,
                sourceLineKey: variant.id,
              };
              foundPrices.add(variant.id);
            }

            variants.push({
              name: variant.originalLabel === "" ? "As listed" : variant.originalLabel,
              translation: { language: document.targetLanguage, label: variant.translatedLabel },
              price: reviewedPrice,
            });
          }

          const group = groups.get(primary.assetId) ?? [];
          group.push({
            name: item.originalName,
            description: item.originalDescription ?? "",
            translation: {
              language: document.targetLanguage,
              name: item.translatedName,
              description: item.translatedDescription,
              explanation: item.explanatorySummary,
            },
            matchKind: "suggestion",
            variants,
          });
          groups.set(primary.assetId, group);
          const supports = supportingAssets.get(primary.assetId) ?? new Set<string>();

          for (const reference of item.sourceReferences) supports.add(reference.assetId);
          supportingAssets.set(primary.assetId, supports);
        }

        if (foundItems.size !== selectedItems.size || foundPrices.size !== selectedPrices.size)
          return yield* new ScanInputError({
            reason:
              "Review selections must belong to this exact submitted revision and its selected items.",
          });

        if (groups.size === 0)
          return yield* new ScanInputError({
            reason: "Approval requires at least one reviewed item.",
          });

        const menuTitle = document.menuTitle ?? "Reviewed menu";
        const orderedGroups = [...groups.entries()];
        let primaryMenuId: string | null = null;

        for (const [index, [assetId, groupItems]] of orderedGroups.entries()) {
          const asset = byAssetId.get(assetId);

          if (asset === undefined || asset.object_key === null)
            return yield* new ScanInputError({
              reason: "A selected item has missing private source evidence.",
            });

          // Reuse registered private bytes. They retain the original consented
          // expiry and cleanup lifecycle; no untracked copy or network work in this transaction.
          const evidenceKey = asset.object_key;

          const imported = yield* importMenu({
            venueId,
            menuName: orderedGroups.length === 1 ? menuTitle : `${menuTitle} (p. ${index + 1})`,
            sourceLanguage: document.sourceLanguage,
            source: {
              category: "menu_photo",
              privateObjectKey: evidenceKey,
              deduplicationKey: `menu-contribution:${contribution.id}:${assetId}`,
              restaurantVerified: false,
              observedAt: input.observedAt,
              validUntil: input.validUntil,
            },
            items: groupItems,
          });

          for (const priceId of imported.priceIds)
            yield* reviewObservation({ kind: "price", id: priceId, status: "approved" });

          // Explicitly reviewed items can be published without prices. All variants
          // remain the reviewed source labels; no canonical dish match is inferred.
          for (const offering of imported.offeringIds) {
            yield* setOfferingStatus({ kind: "item", id: offering.itemId, status: "published" });
            yield* setOfferingStatus({
              kind: "variant",
              id: offering.variantId,
              status: "published",
            });
          }

          yield* setMenuStatus({ menuId: imported.menuId, status: "published" });
          yield* runQuery("menu/promotion-menu", (sql) =>
            promotionMenu.run(sql, {
              contribution_id: contribution.id,
              menu_id: imported.menuId,
              asset_id: assetId,
              evidence_key: evidenceKey,
              is_primary: index === 0,
              supporting_asset_ids: [...(supportingAssets.get(assetId) ?? new Set<string>())],
            }),
          );

          if (index === 0) primaryMenuId = imported.menuId;
        }

        menuId = primaryMenuId;
      }

      const reviewed = yield* runQuery("menu/review-contribution", (sql) =>
        reviewContribution.run(sql, {
          id: contribution.id,
          status: input.decision,
          actor: actorId,
          notes: input.notes,
          menu_id: menuId,
        }),
      );

      if (reviewed === null)
        return yield* new ScanConflict({
          reason: "Another reviewer already decided this contribution.",
        });

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: randomUUID(),
        event: `restaurant.contribution.${input.decision}`,
        metadata: {
          channel: input.channel ?? "not_applicable",
          rightsReviewed: String(input.rightsReviewed),
          consentTerms: contribution.consent_terms,
        },
        outcome: "succeeded",
        resource: contribution.id,
      });

      return reviewed;
    }),
  );
});
