import { createFileRoute } from "@tanstack/react-router";

import { handleMenuScanRequest } from "@/modules/restaurant-discovery/server/scan-http";

export const Route = createFileRoute("/api/menu-scans")({
  server: {
    handlers: {
      GET: ({ request }) => handleMenuScanRequest(request),
      POST: ({ request }) => handleMenuScanRequest(request),
    },
  },
});
