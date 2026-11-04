import { createFileRoute } from "@tanstack/react-router";

import { handleRecommendStream } from "@/modules/food-discovery/server/agent/progress-transport";
import { appRuntime } from "@/server/runtime";

/**
 * POST /api/v1/recommendations/stream — SSE progress + final result.
 * Additive endpoint gated by RECOMMEND_AGENT_ENABLED; the existing
 * recommendDishesFn JSON contract is untouched. See
 * docs/architecture/recommendations-agent-transport.md.
 */
export const Route = createFileRoute("/api/v1/recommendations/stream")({
  server: {
    handlers: {
      POST: ({ request }) => appRuntime.runPromise(handleRecommendStream(request)),
    },
  },
});
