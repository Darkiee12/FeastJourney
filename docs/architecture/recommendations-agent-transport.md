# Recommendations agent transport (streaming progress)

**Status: Wired; pending CI validation.** The stream transport, client
controller, offline fixture eval, provider adapter, agent pool wiring, and
per-request route selection exist. CI validation is pending; the fixture
eval is not evidence of live agent recommendation quality.

## Decision

**SSE framing over `POST /api/v1/recommendations/stream`, consumed with
`fetch()` + `ReadableStream` + incremental parsing.** Not `EventSource`
(it cannot send POST bodies, so the rich location/exclusion payload would
have to move into URLs — leaking filters into logs and hitting URL length
limits). Not NDJSON (SSE's named `progress` / `result` / `error` events
give the client a typed dispatch without custom framing; byte cost is
equivalent).

Server: `src/modules/food-discovery/server/agent/progress-transport.ts`
(`handleRecommendStream`, `agentPipeline`, `deterministicPipeline`), route
`src/routes/api/v1/recommendations.stream.ts`, codec
`src/modules/food-discovery/server/agent/stream-codec.ts` (isomorphic —
no server runtime imports; domain imports are type-only).
Provider seam: `src/server/integrations/meta-agent.ts`
(`makeAgentModelClientLive` — single-turn `AgentModelClient` adapter over
Chat Completions; the unused `MetaAgent.runLoop` stays for reference).
Pool + hydration: `resolveAgentPool` / `hydrateAgentSelected` /
`hydrateAgentFallback` in
`src/modules/food-discovery/server/operations/recommendation-service.ts`
(additive; the deterministic `recommend` flow is untouched).
Client: `src/components/home/recommend/agent-progress-controller.ts`
(framework-agnostic; lane C wires it into the quiz UI).

The existing `recommendDishesFn` JSON contract is untouched. When
`RECOMMEND_AGENT_ENABLED` is unset/off, the new endpoint returns JSON
`404 {error:"agent_disabled"}`; the old endpoint keeps serving byte-identical
results (flag-off path). Rollback = unset the flag.

## Request/response contract

```
POST /api/v1/recommendations/stream
content-type: application/json
x-request-id: <fresh request correlation ID>
body: <recommendationQuerySchema>   (same payload as recommendDishesFn)
```

Pre-stream failures return plain JSON (same semantics as the old path):

| condition | status | body |
| --- | --- | --- |
| flag off | 404 | `{error:"agent_disabled"}` |
| unparseable body | 400 | `{error:"invalid_input"}` |
| schema violation | 400 | `{error:"invalid_input", message}` |
| over budget | 429 | `{error:"rate_limited", retryAfterSeconds}` + `Retry-After` |
| limiter store down | 503 | `{error:"temporarily_unavailable"}` |
| suspended session | 403 | `{error:"forbidden"}` |
| session store down | 503 | `{error:"temporarily_unavailable"}` |

Stream (`200 text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`, `X-Request-Id` echo). Frames: `progress`
(`ProgressEvent` per `protocol.ts`), then exactly one `result`
(`{requestId, wire: RecommendationWireOutcome}`) or one `error`
(`{requestId, code, retryAfterSeconds?}`). `: ping` comments every 15 s
reset proxy idle timers.

## Guard order (all before expensive work and the first stream byte)

flag → body validation → rate-limit `search` budget → session identity.
Rate-limit identity derivation is header/config-only; the session lookup is
the only I/O and it gates member-vs-guest ranking. A failing guard means
the pipeline never runs (asserted: 404/429 tests inject a counting
pipeline and expect zero calls).

## Lifecycle invariants (enforced, not promised)

- `seq` assigned server-side from 0, strictly increasing; consumers drop
  stale/out-of-order/duplicates (`ProgressSink`).
- `terminal` flag must agree with the stage; mismatch frames drop.
- Exactly one terminal event; nothing is written after it
  (`ProgressEmitter` closes; post-close calls return null).
- Terminal `failed` always pairs with an `error` event, then close — the
  consumer can never hang waiting for a terminal frame.
- Details carry counts and labels only: never coordinates, raw exclusion
  terms, reasoning, or candidate internals beyond the final validated wire.

## Cancellation

Client disconnect (`request.signal`) interrupts the worker fiber via
top-level `Effect.runFork(Fiber.interrupt(...))`: no orphaned provider
calls, no writes to a dead stream. The supervisor still settles the
stream (failed terminal + close) so readers resolve instead of hanging.
The whole pipeline also races `RECOMMEND_TIMEOUT_MS` (default 120 s).

## Client correctness rules (controller)

- Only a terminal-gated result commits: progress alone, terminal without
  a result, or a truncated stream never commit data (retryable errors).
- Stale guard: only the latest started attempt commits (`attempt` serial);
  older attempts cannot update progress, result, or error state.
- Concurrent duplicate submissions share one in-flight fetch (no competing
  results); different keys run independently.
- Back-nav cache: terminal results cached by canonical key with 5 min TTL
  and 20-entry bound. Cache identity = canonical payload + actor id +
  locale + agent flag (per-user isolation; no cross-actor leaks).
- Retry = new attempt with a fresh request id.

## Limits

| bound | value | source |
| --- | --- | --- |
| agent rounds / tool calls / pool / final | explicit operator values | `RECOMMEND_AGENT_MAX_ROUNDS`, `RECOMMEND_AGENT_MAX_TOOL_CALLS`, `RECOMMEND_AGENT_CANDIDATE_POOL_CAP`, `RECOMMEND_AGENT_FINAL_LIMIT` |
| details per call | explicit operator value | `RECOMMEND_AGENT_DETAILS_PER_CALL` |
| provider call timeout | explicit operator value | `MODEL_AGENT_TIMEOUT_MS` |
| orchestration deadline | explicit operator value | `RECOMMEND_AGENT_DEADLINE_MS` |
| stream pipeline timeout | `RECOMMEND_TIMEOUT_MS` default 120 s | `appConfig` |
| search rate budget | 20 / 60 s default | `RATE_LIMIT_SEARCH*` |
| heartbeat | 15 s comment | transport |

Queue/durable-job verdict: not needed. Streams are request-scoped on a
single deployment; a dead process drops its streams and clients retry.
Revisit only if streams must survive deploys. Inherited caveat:
`RateLimiterLive` is in-memory per replica, so Swarm budgets are
per-replica, not global (same as the existing path).

## Environment examples

```sh
# Agentic streaming progress (new endpoint live; old endpoint unchanged)
RECOMMEND_AGENT_ENABLED=1
RECOMMEND_TIMEOUT_MS=120000
RECOMMEND_AGENT_MAX_ROUNDS=3
RECOMMEND_AGENT_MAX_TOOL_CALLS=8
RECOMMEND_AGENT_DETAILS_PER_CALL=10
RECOMMEND_AGENT_CANDIDATE_POOL_CAP=60
RECOMMEND_AGENT_FINAL_LIMIT=10
MODEL_AGENT_TIMEOUT_MS=20000
RECOMMEND_AGENT_DEADLINE_MS=90000

# Provider for lane B member ranking (existing contract, unchanged)
RECOMMENDATION_PROVIDER=muse
MODEL_API_KEY=...
MODEL_MODEL_ID=muse-spark-1.3-contributor
MODEL_BASE_URL=https://api.meta.ai/v1
```

These are example operator choices, not built-in agent defaults. The stream
path (guard, route, pipeline) consistently uses `isAgentStreamEnabled`
(`1`, `true`, `yes`); the legacy `meta-agent.ts` `isAgentEnabled`
(`"true"` only) is not consulted on this path.

## Production pipeline (wired)

The route selects the pipeline from `RECOMMEND_AGENT_ENABLED`
(`isAgentStreamEnabled`: `1`/`true`/`yes`); the handler default stays
`deterministicPipeline`. When the flag is on, `agentPipeline` runs the
tool-using loop; every precondition failure delegates back to
`deterministicPipeline` except hard misconfiguration, which fails closed:

```
flag off → deterministicPipeline (byte-identical to flag-off)
guest actor or surpriseSeed > 0 → deterministicPipeline (guests never
  spend model budget; surprise stays a deterministic pool slice)
bounds / ranking / agent-config sync throw → RecommendationMisconfigured
  (loud; never a defect)
ranking Deterministic → deterministicPipeline
ranking Misconfigured → RecommendationMisconfigured (loud, no fallback)
pool empty or eligibility malformed → deterministicPipeline (honest Empty)
Selected → hydrateAgentSelected (LiveMuse cards with ID-keyed reasons)
DeterministicFallback → hydrateAgentFallback (DegradedMuse + warning)
```

Precondition resolution order: flag → bounds (`resolveAgentBounds`,
protocol) → ranking config (`resolveRankingConfig`, must be the Muse
variant) → agent config (`agentConfigFromMuse`) → pool
(`resolveAgentPool`, candidate limit = `candidatePoolCap`) → `runAgentLoop`
with a per-request `AgentModelClient` layer (`makeAgentModelClientLive`,
provided locally) over ambient Database / IngredientRepository /
DishRelationsRepository, forwarding non-terminal stages to the transport
emitter. Terminal events stay owned by the transport. The transport passes
its request id into the pipeline (`StreamPipeline` third parameter) so
agent logs join the stream request; direct pipeline callers fall back to a
fresh UUID. A-loop wins: the orchestrator owns bounds, transcript,
execution, and validation; the adapter is single-turn only (no
self-timeout — the orchestrator applies the per-turn timeout; interruption
already propagates through the adapter's `tryPromise` signal).

## Lane B handoff (done)

Replaced `deterministicPipeline` with the tool-using agent:

```ts
export type StreamPipeline = (
  input: RecommendDishesInput,
  report: StageReporter,
  requestId?: string,
) => Effect.Effect<RecommendationOutcome, RecommendationError, PipelineDeps>;
```

Emit `muse-curating` / `inspecting-dishes` through `report` as work
actually starts; the transport owns terminal events and never forwards
reasoning, coordinates, or raw exclusions.

## Open risks

- `AGENT_BOUNDS` still parses on first server-side access (lazy getters, no
  import-time throw); `agentPipeline` additionally parses explicitly via
  `resolveAgentBounds(process.env)` so a bad value fails closed as
  `RecommendationMisconfigured`. Keep protocol types browser-import-safe
  (`import type` only).
- The quiz still uses JSON RPC. Branch consolidation alone does not activate
  real quiz progress; the stream endpoint is live but the quiz does not
  consume it yet.
- No member-path stream test (needs a live session); covered by existing
  actor tests + the guest stream path.
- Flag parsing is not yet unified: the stream path (guard, route, pipeline)
  consistently uses `isAgentStreamEnabled` (`1`/`true`/`yes`), while
  `meta-agent.ts` `isAgentEnabled` accepts only `"true"` and `bounds.ts`
  `isAgentEnabled` accepts `"1"`/`"true"`. Unify before removing the
  flag-off fallback.
- Surprise slices and guest requests intentionally bypass the agent
  (deterministic path); the agent pool mirror in `resolveAgentPool` must be
  kept in sync with the deterministic scope dispatch until a shared
  pool-fetch is extracted.
