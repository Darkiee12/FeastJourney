import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  localizationTargetSchema,
  MAX_PRE_ENRICH_TARGETS,
} from "@/modules/restaurant-discovery/menu-localization-targets";

/**
 * Menu-localization transport: Zod 4.6 validation at the boundary, public
 * cached reads, controlled on-demand generation for cache misses, and
 * staff-gated pre-enrich plus curator verdicts. The panel (coordinator-owned)
 * consumes these; this file owns no rendering.
 *
 * Imports the owning operation module directly; server/index.ts stays
 * coordinator-owned (needed barrel exports are reported, not added here).
 * restaurant.functions.ts is sibling-owned and untouched.
 */

const uuidSchema = z.uuid();

const venueTargetSchema = z.object({
  venueId: uuidSchema,
  target: localizationTargetSchema,
});

const preenrichSchema = z.object({
  venueId: uuidSchema,
  targets: z.array(localizationTargetSchema).min(1).max(MAX_PRE_ENRICH_TARGETS),
});

const decideSchema = z.object({
  id: uuidSchema,
  status: z.enum(["approved", "rejected"]),
});

// Authentication builds the Actor; every privileged operation additionally checks its own grant.
const memberContext = async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { requireAuthenticatedActor } = await import("@/server/auth/session");
  const { Actor } = await import("@/server/auth/actor");
  const { withActor } = await import("@/server/auth/current-actor");
  const { runClientOperation } = await import("@/server/http/run-client-operation");

  const session = await runClientOperation(requireAuthenticatedActor(getRequestHeaders()), "admin");

  return { actor: Actor.Member({ userId: session.userId }), withActor, runClientOperation };
};

const localizationOperations = () =>
  import("@/modules/restaurant-discovery/server/operations/menu-localizations");

/**
 * Public: stored servable machine/approved rows for one venue in one
 * target language or style. Rejected rows are never served. Guests allowed;
 * this is the cache read behind useMenuLocalizations.
 */
export const getMenuLocalizationsFn = createServerFn({ method: "GET" })
  .validator(venueTargetSchema)
  .handler(async ({ data }) => {
    const { listVenueLocalizations } = await localizationOperations();
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    const rows = await runClientOperation(listVenueLocalizations(data.venueId), "public");

    return rows.filter((row) => row.target === data.target);
  });

/**
 * Public: controlled on-demand generation for cache misses. Reads stored
 * rows first (zero provider cost for unchanged text), generates only for
 * units with no matching-hash machine row, and never touches
 * curator-approved or rejected rows. Rate-limited like search; budget and
 * rate-limit failures defer instead of failing the menu read. The panel
 * keeps showing the original menu text while this runs.
 */
export const ensureMenuLocalizationsFn = createServerFn({ method: "POST" })
  .validator(venueTargetSchema)
  .handler(async ({ data }) => {
    const { ensureVenueLocalizations } = await localizationOperations();
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(
      ensureVenueLocalizations({ venueId: data.venueId, target: data.target }),
      "search",
    );
  });

/** Staff: pre-generate machine rows for common languages ahead of demand. Requires restaurant:manage. */
export const preenrichMenuLocalizationsFn = createServerFn({ method: "POST" })
  .validator(preenrichSchema)
  .handler(async ({ data }) => {
    const { preenrichVenueLocalizations } = await localizationOperations();
    const { actor, withActor, runClientOperation } = await memberContext();

    return runClientOperation(
      withActor(
        actor,
        preenrichVenueLocalizations({ venueId: data.venueId, targets: data.targets }),
      ),
      null,
    );
  });

/** Staff: curator verdict on one machine suggestion. Requires restaurant:review. */
export const decideMenuLocalizationFn = createServerFn({ method: "POST" })
  .validator(decideSchema)
  .handler(async ({ data }) => {
    const { decideLocalization } = await localizationOperations();
    const { actor, withActor, runClientOperation } = await memberContext();

    return runClientOperation(
      withActor(actor, decideLocalization({ id: data.id, status: data.status })),
      null,
    );
  });
