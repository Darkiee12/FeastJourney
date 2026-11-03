import { createRouter, stringifySearchWith } from "@tanstack/react-router";

import { routeTree } from "@/routeTree.gen";
import { parseTextSearch } from "@/shared/search-params";

// Start creates a router for each request. Never share one across SSR requests.
export function getRouter() {
  return createRouter({
    routeTree,
    parseSearch: parseTextSearch,
    stringifySearch: stringifySearchWith(JSON.stringify),
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
