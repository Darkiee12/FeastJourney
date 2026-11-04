/**
 * Test/dev environment fixture for the env-required agent contract.
 *
 * `protocol.ts` throws at load time unless all 7 bound variables are set,
 * and ESM imports evaluate before any test body runs — so every agent test
 * file imports this module FIRST (before anything that transitively reaches
 * the protocol). Values are stated explicitly here, matching the documented
 * production numbers; there is intentionally no fallback logic.
 *
 * Coordinator note: `tests/bootstrap.ts` (and `.env.example`) do not set
 * these yet — CI/dev shells need the same 7 variables wherever the agent
 * protocol is loaded.
 */

const TEST_AGENT_BOUNDS: Readonly<Record<string, string>> = {
  RECOMMEND_AGENT_MAX_ROUNDS: "3",
  RECOMMEND_AGENT_MAX_TOOL_CALLS: "8",
  RECOMMEND_AGENT_DETAILS_PER_CALL: "10",
  RECOMMEND_AGENT_CANDIDATE_POOL_CAP: "60",
  RECOMMEND_AGENT_FINAL_LIMIT: "10",
  MODEL_AGENT_TIMEOUT_MS: "20000",
  RECOMMEND_AGENT_DEADLINE_MS: "90000",
};

for (const [key, value] of Object.entries(TEST_AGENT_BOUNDS)) {
  process.env[key] = value;
}

export const TEST_AGENT_BOUND_VALUES = TEST_AGENT_BOUNDS;
