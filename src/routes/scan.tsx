import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { MenuScanPage } from "@/modules/restaurant-discovery/components/menu-scan-page";
import { localeSearchSchema } from "@/shared/i18n";

export const Route = createFileRoute("/scan")({
  // Accept any bounded string here: MenuScanPage validates the branch ID
  // itself (typed "unknown branch" hint, task-surfaced errors) so a bad
  // ?venueId degrades instead of tripping the route error boundary.
  // returnVenue/returnView carry the originating restaurant context so the
  // scanner can offer a contextual return without exposing raw history.
  // returnView "copilot" carries a Muse Dining Copilot origin instead: the
  // page offers a return to /muse rather than a restaurant view.
  validateSearch: localeSearchSchema.extend({
    venueId: z.string().max(36).optional(),
    returnVenue: z.uuid().optional(),
    returnView: z.enum(["overview", "menu", "reviews", "copilot"]).optional(),
  }),
  component: ScanRoute,
});

function ScanRoute() {
  const search = Route.useSearch();

  const { session } = Route.useRouteContext();

  const userId = session.status === "signed-in" ? session.user.id : null;

  // Identity-keyed remount: private scan state (view, document, photos) must
  // never survive an account switch in an already-mounted page.
  return (
    <MenuScanPage
      key={userId ?? "guest"}
      locale={search.lang}
      userId={userId}
      venueId={search.venueId}
      returnVenue={search.returnVenue}
      returnView={search.returnView}
    />
  );
}
