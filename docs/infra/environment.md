# Environment configuration and secrets

## Local Compose `infra/.env`

Copy `infra/.env.example` to `infra/.env`. Required local-only variables:

| Variable | Owner | Notes |
| --- | --- | --- |
| `POSTGRES_USER` | PostgreSQL initialization + Flyway | Local bootstrap account; do **not** assume this role is suitable for production app queries |
| `POSTGRES_PASSWORD` | PostgreSQL initialization + Flyway | Local-only, never publish/log |
| `POSTGRES_DB` | PostgreSQL initialization + Flyway | Injected into Flyway JDBC URL; must match initialized database |
| `GARAGE_RPC_SECRET` | Garage node/CLI | 32 random bytes encoded as 64 hex characters; server-only |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Garage local bucket bootstrap / future app | Fresh local S3 credentials; distinct from the RPC secret |

Flyway image is pinned to `flyway/flyway:13.11.1` in `infra/compose.yaml`. It reads:

- `FLYWAY_URL=jdbc:postgresql://postgres:5432/${POSTGRES_DB}`
- `FLYWAY_USER`, `FLYWAY_PASSWORD`: wired to local Postgres bootstrap values only.
- `FLYWAY_SCHEMAS=feastjourney`, `FLYWAY_DEFAULT_SCHEMA=feastjourney`: extension objects are initialized in `public`, but Flyway history and FeastJourney application tables are in their own schema.
- `FLYWAY_VALIDATE_MIGRATION_NAMING=true`, `FLYWAY_BASELINE_ON_MIGRATE=false`, `FLYWAY_CLEAN_DISABLED=true`.

Its SQL directory is mounted read-only at `/flyway/sql`. A `flyway_schema_history` record is created in Postgres when migration tooling initializes an appropriate schema; this is not a replacement for a database backup.

## Production role separation

**Never** use the app runtime account as the schema owner or migration superuser. Use a controlled DDL/migrator credential with ownership/migration privileges appropriate to the schema and a separate app credential with only required SELECT/INSERT/UPDATE/DELETE/USAGE rights. Manage grants in reviewed provisioning/migrations without embedding passwords in SQL or configuration committed to Git.

The application must not receive `FLYWAY_PASSWORD` or DDL credentials; the migrator must not receive AI/S3 secrets. Flyway is executed by a pre-deploy job rather than as part of every server process.

## App and Reylo variables

Server-validated application variables (`src/server/env.ts` — startup fails
fast when a required value is missing; see `.env.example` for the full list):

- Required: `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`,
  `FACEBOOK_CLIENT_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`,
  `SMTP_PASSWORD`, `EMAIL_FROM`.
- Optional: `TRUSTED_PROXIES`, `DATABASE_POOL_MAX`, `CORS_ORIGINS`,
  `RATE_LIMIT_*`, `REQUEST_TIMEOUT_MS`, `HOST`, `PORT`,
  `RECOMMENDATION_PROVIDER`, `MODEL_API_KEY`, `MODEL_MODEL_ID`,
  `MODEL_BASE_URL`, `MODEL_TIMEOUT_MS`, `MODEL_CANDIDATE_LIMIT`,
  `MODEL_OUTPUT_LIMIT`, `MODEL_MAX_TOKENS`, `OWNER_EMAIL`,
  `RECOMMEND_AGENT_ENABLED`, `RECOMMEND_AGENT_MAX_ROUNDS`,
  `RECOMMEND_AGENT_MAX_TOOL_CALLS`, `RECOMMEND_AGENT_DETAILS_PER_CALL`,
  `RECOMMEND_AGENT_CANDIDATE_POOL_CAP`, `RECOMMEND_AGENT_FINAL_LIMIT`,
  `MODEL_AGENT_TIMEOUT_MS`, `RECOMMEND_AGENT_DEADLINE_MS`,
  `MENU_SCANNER_ENABLED`, `MENU_SCAN_*`, `WEB_RESEARCH_ENABLED`,
  `WEB_RESEARCH_*`, `REVIEW_INTELLIGENCE_ENABLED`,
  `REVIEW_INTELLIGENCE_TIMEOUT_MS`, `REVIEW_INTELLIGENCE_MODEL_ID`,
  `REVIEW_INTELLIGENCE_MAX_COMPLETION_TOKENS`,
  `REVIEW_INTELLIGENCE_MAX_SAMPLE`,
  `REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES`, `COPILOT_VISION_ENABLED`,
  `COPILOT_VISION_TIMEOUT_MS`, `COPILOT_VISION_MAX_COMPLETION_TOKENS`,
  `COPILOT_SYNTHESIS_MAX_COMPLETION_TOKENS`,
  `MENU_LOCALIZATION_MAX_COMPLETION_TOKENS`,
  `WEB_RESEARCH_MAX_OUTPUT_TOKENS`, `FX_ENDPOINT`, `FX_REFRESH_HOURS`,
  `FX_MAX_AGE_HOURS`. `DATABASE_DIRECT_URL` is declared in server config
  but not consumed by any application path yet.

- `DATABASE_URL`: server-only PostgreSQL connection for application runtime or direct Reylo development type analysis, as appropriate.
- For Reylo analysis, the URL must point **directly** to a migrated Postgres schema; avoid transaction-mode PgBouncer. A distinct development/CI connection may be used instead of the runtime pool URL.
- `S3_ENDPOINT_INTERNAL=http://garage:3900`, `S3_REGION=garage`, `S3_BUCKET_PRIVATE=feastjourney-private`, `S3_BUCKET_MEDIA` (defaults to the private bucket), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; use path-style S3 addressing. The internal URL only works inside the Compose/Swarm `infra` network. `DishMediaStorage` fails fast with `DishMediaStorageMisconfigured` when endpoint or credentials are absent.
- Swarm adds separated Garage bootstrap/admin identity: `GARAGE_RPC_SECRET`, `GARAGE_BOOTSTRAP_ACCESS_KEY`, `GARAGE_BOOTSTRAP_SECRET_KEY` (Garage service only; never given to the app). See `infra/.env.production.example` and [object storage](object-storage.md) for provisioning (`garage-provision.sh`), rotation, and backup contracts.
- `S3_ENDPOINT_PUBLIC`: browser-valid presigned hostname, deliberately unset until an approved loopback mapping or reverse proxy exists. Do not sign browser URLs for `garage:3900` or rewrite signed hostnames afterward.
- `AI_PROVIDER`, `AI_API_KEY`, `PLACES_API_KEY`, `APP_BASE_URL` and optional `LOG_LEVEL` are **not** application variables: no code reads them. The implemented equivalents are `RECOMMENDATION_PROVIDER`, `MODEL_*`, and `BETTER_AUTH_URL`. Do not reintroduce the old names.

## Operator configuration principle

The deployment operator owns environment configuration. Every operator-set
value in `MODEL_*`, `MENU_SCAN_*`, `COPILOT_VISION_*`, `WEB_RESEARCH_*`,
`REVIEW_INTELLIGENCE_*`, `RECOMMEND_AGENT_*`, `REQUEST_TIMEOUT_MS`,
`RECOMMEND_TIMEOUT_MS`, and
rate-limit/storage knobs flows through exactly as configured: defaults apply
only when a variable is unset, and there are intentionally no upper bounds.
Explicitly set invalid values (non-positive timeouts, negative retries,
unusable URLs, wrong model shapes) fail loudly with field + reason in server
logs — never silently clamped or replaced, and never with credentials.
Derived budgets stay intentional and documented: the chat backstop derives
from the synthesis budget plus tool budgets, the photo deadline from the
vision budget, the extraction lease from the scan budget, and the browser
polls the scan view instead of holding one long request. Provider-side limits
remain the provider's responsibility and surface as provider failures.
Genuine technical limits (provider inline-payload size, decode-bomb guards,
guest-endpoint attempt/concurrency caps, proxy timeouts) are documented at
their use sites, not silently applied to operator values.

### Per-integration token/output budgets

Each AI integration below owns exactly one operator-set budget variable;
`MODEL_MAX_TOKENS` governs **only** the dish-ranking call and is never
assumed to govern any other feature. Defaults apply only when the variable
is unset; explicit valid values flow through exactly as configured (no
upper bounds, no silent ceilings); explicit invalid values fail loudly
with field + reason in server logs, never with credentials.

| Variable | Default | What it budgets | Interaction |
| --- | --- | --- | --- |
| `MODEL_MAX_TOKENS` | `4000` | Ranking call only (reasoning + output). | Independent; no other feature reads it. |
| `COPILOT_SYNTHESIS_MAX_COMPLETION_TOKENS` | `1200` | One copilot synthesis call (`max_tokens`, Chat Completions). | The chat backstop (`resolveCopilotChatDeadlineMs`) derives from the synthesis **timeout** plus `COPILOT_MAX_TOOL_CALLS × TOOL_TIMEOUT_MS` plus margin — a timeout, not this token budget. |
| `COPILOT_VISION_MAX_COMPLETION_TOKENS` | `2000` | One food-photo vision call (`max_tokens`, Chat Completions). | The photo server function derives its deadline from `COPILOT_VISION_TIMEOUT_MS` plus scan-read overhead, not from this budget. |
| `MENU_LOCALIZATION_MAX_COMPLETION_TOKENS` | `4000` | One localization batch call (`max_tokens`, Chat Completions). | Independent per-batch budget; monthly call/char ceilings stay hardcoded (see below). |
| `WEB_RESEARCH_MAX_OUTPUT_TOKENS` | `2000` | One web-research call (`max_output_tokens`, Responses endpoint — note the field name differs from Chat Completions `max_tokens`). | Parsed in both `research-config.ts` (info) and `meta-responses.ts` (operative gate) with identical strict semantics. |
| `REVIEW_INTELLIGENCE_MAX_COMPLETION_TOKENS` | `12000` | One review-highlights call (`max_tokens`, Chat Completions). | Matches the menu-scanner budget for the same endpoint family; the provider limit stays final. |
| `REVIEW_INTELLIGENCE_MODEL_ID` | `MODEL_MODEL_ID`, then `muse-spark-1.3` | Pins review output to one model independently of ranking-model churn. | Must satisfy the shared supported-model shape; invalid ids fail fast at startup. |
| `REVIEW_INTELLIGENCE_MAX_SAMPLE` | `12` | Reviews sent to the provider in one call. | Output-contract bounds (overview/bullet/snippet lengths) stay hardcoded. |
| `REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES` | `24576` (24 KiB) | Response-body read budget. | Cache TTLs/entries and per-review char bounds stay hardcoded. |

**Important:** local Compose intentionally publishes no database port, so a host `DATABASE_URL=postgres://localhost:5432/...` is **not** reachable without a separate, explicitly approved dev access arrangement. Never solve this by exposing 0.0.0.0:5432.

## Map frontend configuration

`VITE_MAP_STYLE_URL` is a **public browser-visible** MapLibre vector-style
URL for the `/restaurants` map (gated by `z.url().safeParse` at
`src/modules/restaurant-discovery/components/restaurant-search-page.tsx:85`
and `restaurant-map.tsx:318`, plus
`restaurant-editor.tsx:95`). The single validated default is the CARTO
Positron style (`https://basemaps.cartocdn.com/gl/positron-gl-style/style.json`,
no key required); the canonical constant lives in
`src/shared/map-style-url.ts`. Domain/referrer-restrict any keyed provider
key and monitor API usage. **Never** use this browser variable for private
database, AI, or S3 credentials. Provider terms and pricing must be reviewed
before production.

### Why build-time, not runtime

Vite replaces `import.meta.env.VITE_MAP_STYLE_URL` with a string literal
while compiling the client bundle, and `infra/Dockerfile.prod` packages only
that prebuilt `.output/` artifact. A Swarm/Dokploy runtime value therefore
cannot change the served map — the bundle already froze the old value in.
Setting `VITE_MAP_STYLE_URL` in the stack environment is informational only
(so operators can see which style a release expects); the compiled bundle
is the truth.

### How to configure in Actions

Both `quality.yml` (PR gate) and `release.yml` (release gate) run
`.github/workflows/scripts/resolve-map-style-url.ts` before `bun run build`:

- Source: the GitHub Actions **repository variable** `vars.VITE_MAP_STYLE_URL`
  (Settings → Secrets and variables → Actions → Variables). Variables, not
  secrets: the value is public and the step stays fork-safe.
- A set and valid override wins; an unset or blank variable falls back to
  the validated default — deterministic, never silently map-less.
- Malformed or non-HTTPS overrides fail the step with a named fix
  (variable name + remediation, never the value). The resolved value is
  exported into the build step env so Vite embeds it, and a follow-up step
  greps `.output/public` for the exact URL to prove the bundle carries it.

### When a rebuild is required

Any style change (new provider, new key, new style JSON) requires a new
image build plus a stack redeploy; editing the Dokploy stack environment
alone changes nothing user-visible. Roll back the same way: rebuild (or
re-promote a previous immutable `:sha-` tag) and redeploy.

### Missing-config vs tile-failure diagnosis

- **Missing config** (bundle built without a value): the map area shows
  "Map tiles are not configured here (VITE_MAP_STYLE_URL is unset)" while
  the list, addresses, and directions keep working. Fix: set the Actions
  variable (or accept the default) and rebuild — not a runtime env edit.
- **Tile failure** (value embedded but tiles do not load): the map area shows
  "The map could not load. The list and directions remain available."
  Fix on the provider side: key restrictions, quota/billing, network egress
  from the browser to the tile host — the bundle is fine, do not rebuild.

### Migrating to MapTiler

MapTiler is the recommended keyed provider (subject to pricing/license
review, see `docs/architecture/maps.md`): create a style, restrict the key
by domain/referrer, set `vars.VITE_MAP_STYLE_URL` to the style JSON URL,
rebuild, and confirm the embed-proof step passes. Monitor usage and set
billing alerts before production.

## Production and staging configuration

Staging and production share variable NAMES with local dev but never values:
copy nothing from `infra/.env.example`. The full production template is
`infra/.env.production.example` (placeholders only — real values live in
Dokploy secrets and the GitHub `staging` environment); the provisioning
contract is [deployment on Dokploy + Azure](deployment-dokploy-azure.md).

## Secret handling rules

- Validate server config at startup; fail with sanitized messages when required variables are absent.
- Explicitly allowlist client-visible variables. Never import private DB/migrator credentials into browser components.
- Use managed deployment secret storage and rotate/limit accounts. Rendered Compose config can reveal secret values: prefer `docker compose ... config --quiet` when only validating.
- Do not commit `.env`, keys, private images or database dumps. Do not print secrets in CI traces, PR descriptions or troubleshooting posts.

See [migration operations](migrations.md) and [local runbook](operations.md).
