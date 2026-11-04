import { createFileRoute } from "@tanstack/react-router";

import {
  agentPipeline,
  deterministicPipeline,
  handleRecommendStream,
  isAgentStreamEnabled,
} from "@/modules/food-discovery/server/agent/progress-transport";
import { appRuntime } from "@/server/runtime";

/**
 * POST /api/v1/recommendations/stream — SSE progress + final result.
 * Additive endpoint gated by RECOMMEND_AGENT_ENABLED; the existing
 * recommendDishesFn JSON contract is untouched. See
 * docs/architecture/recommendations-agent-transport.md.
 *
 * Guard order inside the handler is unchanged (flag → body → rate-limit →
 * session before any provider work); the route only selects which pipeline
 * the handler runs once guards pass.
 */
export const Route = createFileRoute("/api/v1/recommendations/stream")({
  server: {
    handlers: {
      POST: ({ request }) =>
        appRuntime.runPromise(
          handleRecommendStream(
            request,
            isAgentStreamEnabled(process.env) ? agentPipeline : deterministicPipeline,
          ),
        ),
    },
  },
});
