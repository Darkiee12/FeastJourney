import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { DiscoveryError } from "@/modules/restaurant-discovery/components/discovery-error";
import { channelSchema } from "@/modules/restaurant-discovery/restaurant.schema";

/**
 * Stable public permalink for one restaurant. The standalone detail page
 * no longer exists: this route normalizes to the canonical map-first
 * experience at /restaurants, preserving locale, channel, dish context,
 * and the menu-item focus. The map behind never remounts because the
 * destination is the same route family, not a second implementation.
 */
export const Route = createFileRoute("/restaurants/$venueId")({
  // Carried from the main-track worktree (dish → venue → dish back-links).
  // Owner sign-off still needed.
  validateSearch: z.object({
    channel: channelSchema.default("dine_in"),
    variant: z.uuid().optional(),
    dish: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional(),
    fromDish: z.string().min(1).max(120).optional(),
  }),
  beforeLoad: ({ params, search }) => {
    const view = search.variant !== undefined || search.dish !== undefined ? "menu" : "overview";

    throw redirect({
      to: "/restaurants",
      search: (previous) => ({
        ...previous,
        lang: previous.lang ?? "en",
        venue: params.venueId,
        view,
        item: search.variant,
        channel: search.channel,
        dish: search.dish,
        fromDish: search.fromDish,
      }),
    });
  },
  errorComponent: DiscoveryError,
  component: VenueRedirectNotice,
});

function VenueRedirectNotice() {
  return (
    <div className="discovery-empty" aria-live="polite">
      Opening the restaurant map…
    </div>
  );
}
