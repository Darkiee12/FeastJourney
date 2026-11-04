# Production deployment: Azure VM + Dokploy + GHCR + Cloudflare Tunnel

**Status:** `Proposed`. Local build/image/runtime steps below are verified
against a disposable database (see Verification); every Azure / Dokploy /
Cloudflare / GHCR step is **UNVERIFIED — operator-side** until a human runs
it. Do not treat this runbook as proof of a working production system.

**Scope:** ships PR #3 (FeastJourney) as a container on an Azure VM managed
by Dokploy, image from GHCR, ingress via the existing Cloudflare Tunnel.
Local development stays on `infra/compose.yaml`; production never uses it.

Related: [infra overview](overview.md), [environment](environment.md),
[PostgreSQL](postgres.md), [migrations](migrations.md),
[operations](operations.md) (local-only).

## 1. Architecture

```text
                    ┌─────────────────────────────────────────────────┐
CI (GitHub Actions, release.yml)                                      │
  tag v*.*.* / dispatch                                                │
    │ quality gate: disposable PG18+PostGIS → migrate → validate        │
    │   → check-types → tests → `bun run build` (.output verified)     │
    ▼                                                                  │
  GHCR push  ghcr.io/<owner>/feastjourney:sha-<SHA>  (+ :<tag>)         │
└──────────────────────────────────────────────────┼──────────────────┘
                                                   │ pull (no webhook
                                                   │ through Access)
                                                   ▼
Azure VM (NSG: 80/443 closed inbound; NO public 3000)                  ┌──────────────┐
  Dokploy                                                               │ Postgres      │
    │ pre-deploy, ONE release-scoped Flyway job (migrator creds)        │ A) Dokploy    │
    │   backup check → migrate → validate → exit 0 gates rollout        │    service on │
    ▼                                                                   │    persistent │
    │ app service: image :sha-<SHA>, env from Dokploy secrets,          │    volume, or │
    │   container port 3000, restart on failure                         │ B) Azure      │
    ▼                                                                   │    Flexible   │
  Traefik (Dokploy) :3000 ──► app container 0.0.0.0:3000                │    Server       │
    ▲                                                                   │ PG18+PostGIS │
    │ tunnel route (cloudflared, host or container — §6)                 │ 3 roles, no   │
    │                                                                   │ public port   │
Cloudflare Edge (DNS: staging.feastjourney.world — UNVERIFIED)          └──────────────┘
    ▲
visitors (browser ⇄ same-origin app; short-lived presigned URLs only
         when object storage lands — Garage is local-only, excluded §9)
```

Dokploy dashboard itself sits behind Cloudflare Access. CI never receives a
webhook through Access (§7); the image flows CI → GHCR → Dokploy pull.

## 2. Release pipeline (`.github/workflows/release.yml`)

New workflow; `quality.yml` is untouched. Reads top-to-bottom as the
release contract:

| Stage | What | Fail-closed behavior |
| --- | --- | --- |
| Trigger | `push` of tags `v*.*.*`, or `workflow_dispatch` | No `pull_request` trigger: fork PRs cannot run it or reach secrets |
| `quality` | Same backend flow as quality.yml against disposable PG18+PostGIS: migrate → validate → `check-types` → `bun test tests/` → resolve `VITE_MAP_STYLE_URL` (Actions variable or validated CARTO default) → `bun run build` → prove `.output/server/index.mjs` + `.output/public` exist and the style URL is embedded → upload `.output` artifact | Any failure stops the release; `publish` never runs |
| `publish` | Downloads the **verified artifact** (same commit), `docker build -f infra/Dockerfile.prod`, pushes SHA tags to GHCR (`packages:write` scoped to this job only, `GITHUB_TOKEN`) | Build requires the artifact proof file; tags are `:sha-<SHA>` plus `:<tag>` on tag events — never `latest`-only |
| `deploy-staging` | `workflow_dispatch` + `deploy_staging=true` ONLY. Triggers Dokploy staging rollout through Cloudflare Access (service token + deploy-scoped `x-api-key`), then polls `…/health/ready` for ≤ 10 min | Never runs on tag push; production is never auto-deployed |

GHCR naming: `ghcr.io/<repository-owner-lowercase>/feastjourney`.
Rollback = redeploy a previous tag: dispatch with `image_tag` set to the
prior `:sha-<SHA>` (or move the Dokploy service back to it in the UI), then
confirm `/health/ready` and Flyway `info`. There is no automated DDL
rollback — DDL rolls forward via reviewed migration (§4, §9).

## 3. Production image (`infra/Dockerfile.prod`)

- Multi-stage `oven/bun:1.4.4` (pinned, matches `packageManager`): stage 1
  installs **production-only** deps (`bun install --frozen-lockfile
  --production`); stage 2 copies `package.json`, `bun.lock`, prod
  `node_modules`, and the CI-verified `.output` — nothing else.
- Never: `bun install` at container start, source mounts, `.env`/`.git`/
  fixtures/`repos/` in the image (enforced by `.dockerignore`, which
  re-includes `.output/` for exactly this Dockerfile).
- Non-root `appuser`; `HOST=0.0.0.0`, `PORT=3000`, `EXPOSE 3000`; exec-form
  `CMD ["bun", ".output/server/index.mjs"]` so PID 1 receives SIGTERM.
- `HEALTHCHECK` uses the Bun runtime itself
  (`bun -e "await fetch('http://127.0.0.1:3000/health/live')…"`) — no curl
  in the image. It probes `/health/live` (DB-free liveness); `/health/ready`
  is for orchestrators/humans, never the restart loop.

## 4. PostgreSQL + Flyway in production

Topology options (operator picks one; both satisfy the contract):

- **A) Dokploy Postgres service.** Persistent volume mounted at
  **`/var/lib/postgresql`** (PG18 layout — never the pre-18 `/data` path),
  no published port, `pg_isready` readiness, PostGIS 3.6 available in-image
  (`postgis/postgis:18-3.6`; version pinned and reviewed like local).
- **B) Azure Database for PostgreSQL Flexible Server.** PG18 + PostGIS
  extension allowed, private networking to the VM (no public endpoint),
  automated backups with point-in-time restore. DBA provisions the
  `postgis` extension and the `feastjourney` schema (managed services often
  restrict superuser — extension install may need the DBA role).

Either way the contract is identical:

1. `feastjourney` schema holds app tables + `flyway_schema_history`;
   extension objects stay in `public`.
2. **Three roles, least privilege** (operator creates in a reviewed SQL
   session; passwords generated per environment, never committed):
   - `feastjourney_owner` — schema owner, extension installs, rare repairs.
   - `feastjourney_migrator` — DDL on `feastjourney.*` + history table only.
   - `feastjourney_app` — `SELECT/INSERT/UPDATE/DELETE` + `USAGE` on
     `feastjourney.*`, Better Auth tables (`"user"`, `"session"`,
     `"account"`, `"verification"`, `"rateLimit"` — see
     `db/migrations/V20261028_005__auth_and_members.sql`), and sequences.
     No DDL, no `SUPERUSER`, no database drop.
3. **Single release-scoped migration gate** (Dokploy pre-deploy / release
   step, same-commit image): backup recovery-point check → `migrate` →
   `validate` → record versions → exit 0. Non-zero exit **blocks the app
   rollout**; the previous app keeps serving. Never run Flyway in app
   replicas, never `baseline`/`repair`/`clean` as routine recovery (§9).

## 5. Environment and secrets

Single template: `infra/.env.production.example` (placeholders only).
Staging and production share variable NAMES; every value (especially
`BETTER_AUTH_URL` and all secrets) differs per environment. Real values
live only in the Dokploy stack environment and the GitHub `staging`
environment — never in git, logs, or chat.
#
# The staging rollout is fully automated: push to `main` -> quality gate ->
# GHCR images (`:sha-<SHA>`) -> CI renders `docker-compose.swarm.yml` with
# pinned tags -> `compose.update` (raw stack) -> `compose.deploy` -> wait
# loop. Roll back with a manual dispatch (`deploy_staging=true` plus an
# existing `image_tag`); production is never automated.

Operator checklist per variable group:

- `BETTER_AUTH_URL` — exact public https origin, no trailing slash.
  Staging proposal: `https://staging.feastjourney.world` (**DNS +
  tunnel route UNVERIFIED**). OAuth redirect URIs derive from it:
  `<origin>/api/auth/callback/google`,
  `<origin>/api/auth/callback/facebook` — register both exactly in the
  Google/Facebook consoles before first login.
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32` per environment;
  rotation logs everyone out (acceptable, announce it).
- `DATABASE_URL` — the **app** role only (`?sslmode=require` on managed
  Postgres). The app never holds migrator/owner credentials.
- `SMTP_*` / `EMAIL_FROM` — deliverability is a launch gate: SPF, DKIM,
  DMARC for the sending domain; then test signup-verify + reset-password
  end-to-end on staging. Mailpit is local-only.
- `TRUSTED_PROXIES` — REQUIRED behind Traefik/tunnel: the Traefik hop
  address/CIDR so rate limiting, audit log, and Better Auth IP handling
  see real clients (`x-forwarded-for`, `x-real-ip`; cf.
  `src/server/http/request.ts`, `src/server/auth/options.ts`). Empty
  locally, exact in production. `CF-Connecting-IP` passes through
  Cloudflare untouched — document which header your chain actually sets.
- `CORS_ORIGINS` — stays empty (same-origin app). Add exact https origins
  only for proven cross-origin callers.
- Rate limits / `REQUEST_TIMEOUT_MS` / `DATABASE_POOL_MAX` — ship defaults;
  tune on p95 evidence, not speculation (small VM: pool 10 is the ceiling
  starting point).
- `MODEL_*` / `RECOMMENDATION_PROVIDER` — default is deterministic and
  startup never needs them. Enabling Muse ranking requires all of
  `provider=muse` + server-side key + supported `muse-spark-*` /
  `muse-wonder-*` id + https base; misconfiguration fails loudly (HTTP
  500). Server-side key only — browser keys forbidden; no Contributor-tier
  key for staging experiments.
- `COPILOT_VISION_*` / `WEB_RESEARCH_*` / `MENU_SCANNER_*` / `MENU_SCAN_*`
  / `REVIEW_INTELLIGENCE_*` — each feature stays disabled unless its
  `*_ENABLED` flag is exactly `true`; all reuse the `MODEL_*` transport.
  Swarm forwards them under `services.app.environment` with code-matching
  defaults, so an unset Dokploy variable means "disabled", never a
  half-configured provider call. Copilot chat synthesis additionally requires
  a signed-in member and first-party facts; guests keep deterministic catalog
  answers.
- `FX_ENDPOINT` / `FX_REFRESH_HOURS` / `FX_MAX_AGE_HOURS` — reference FX
  for local-currency display (Frankfurter v2, display only, never a
  conversion feature flag). Forwarded with the Effect-Config defaults
  (`https://api.frankfurter.dev/v2/`, 24h refresh, 72h max age); override
  only for a mirror endpoint or a different refresh/staleness policy.
- `VITE_MAP_STYLE_URL` — public MapLibre style URL, **build-time only**:
  Vite embeds it into the client bundle from the Actions repository
  variable (validated default: CARTO Positron, no key), and the Swarm value
  is informational — it never changes the served bundle. Changing the
  style means setting the Actions variable, rebuilding the image, and
  redeploying the stack. Never a secret; never put private keys in `VITE_*`.
  Missing value → honest map fallback (list still works); tiles failing to
  load → provider key/quota/egress issue, not a rebuild (see
  [environment](environment.md)).
- CI deploy secrets (GitHub `staging` environment only, never the app):
  `DOKPLOY_URL`, `DOKPLOY_API_KEY` (deploy-scoped `x-api-key`),
  `DOKPLOY_COMPOSE_ID` (the Dokploy **Compose** service id — not the
  project id; find it in the service URL or via `GET /api/project.all`),
  `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (Cloudflare Access
  service token allowed ONLY on the Dokploy dashboard path).

## 6. Tunnel and routing

Visitor path: browser → Cloudflare Edge → **existing** cloudflared tunnel
→ Dokploy Traefik → `container:3000`. No redundant origin TLS between
Traefik and the app (the tunnel already terminates/originates securely;
double-TLS only hides client IPs and breaks health checks).

- **cloudflared placement (document both, assume neither):** (a) host
  daemon on the VM routing to Traefik's published loopback/service port, or
  (b) container/sidecar in the Dokploy project network routing to
  `http://<app-service>:3000`. Record which one the operator chose; both
  keep port 3000 off the public interface.
- **Firewall audit (operator, every deploy):** NSG + host firewall allow
  only tunnel/SSH/Mosh/Access paths; verify `3000` is unreachable from the
  internet (`ss -tlnp`, NSG rules review). Never "fix" connectivity by
  opening ports or disabling the firewall.
- **Reverse-proxy awareness:** app must observe `Host`,
  `X-Forwarded-Proto=https`, `X-Forwarded-For`, and Cloudflare's
  `CF-Connecting-IP`; `TRUSTED_PROXIES` gates which hops are believed.
  Secure cookies follow from the https origin (`BETTER_AUTH_URL`);
  `trustedOrigins` is exactly that origin. Rate limiting keys off the
  resolved client identity — verify a spoofed `X-Forwarded-For` from an
  untrusted hop is ignored (see `resolveIdentityFromHeaders`).

## 7. CI behind Cloudflare Access

Dokploy dashboard is Access-protected; GitHub cannot receive webhooks
through Access (no interactive login, no token-in-URL schemes survive).
So the flow is **GHCR-first**: CI pushes the images; Dokploy pulls them.
Nothing phones home from the VM to GitHub.

The staging deploy is a Dokploy **Compose stack** (`docker-compose.swarm.yml`,
compose type `stack`): CI renders it with pinned `:sha-` tags, pushes the
definition with `POST /api/compose.update` (`sourceType: raw`), rolls it out
with `POST /api/compose.deploy`, and polls `GET /api/deployment.allByCompose`
until the rollout reports done/error (10-minute bound, then fail loud).
Both calls authenticate with the Cloudflare service token
(`CF-Access-Client-Id` / `CF-Access-Client-Secret`) plus the deploy-scoped
Dokploy token (`x-api-key`), all from the GitHub `staging` environment
(narrow scope, read-only to the workflow). The one-shot migrator runs
inside the stack on every rollout, so schema and code always move together.
Never weaken dashboard Access, never put tokens in the image or logs,
never let this job run on PRs.

## 8. Health and lifecycle

- `/health/live` — liveness only: answers without touching the database
  (`handleHealthLive`; safe for restart loops and load-balancer checks).
  A live-but-unready app stays up while the DB incident is investigated.
- `/health/ready` — readiness: bounded `SELECT 1` through the Effect pool
  (`handleHealthReady` → `checkDatabaseHealth`; bounded, no leak — pool
  configured with connect/idle/lifetime timeouts in
  `src/server/database/client.ts`). Dokploy gates traffic on it after a
  grace period; humans poll it post-deploy.
- Dokploy: container port `3000`, restart-on-failure, stop grace ≥ 30s so
  in-flight requests drain on SIGTERM. No extra process manager (one
  process per container). Small-VM restraint: one app replica until load
  evidence says otherwise; pool/timeout defaults already assume this.

## 9. Backups, safety, and what production does NOT run

- Postgres volume persists across container restarts/redeploys (never
  `--volumes` on recovery, never volume deletion as a fix).
- Encrypted offsite backups with retention + **tested restores** (document
  RPO/RTO with the provider); Flyway history is inside the backup.
  Pre-DDL backup recovery point is part of the migration gate.
- Migration failure: stop rollout, read Flyway logs, assess transactional
  state, remediate with a reviewed forward migration. App rolls back only
  if the schema stayed backward-compatible.
- Logs: structured app logs to Dokploy; never print secrets (rendered
  compose/API output redacted; `config --quiet` locally). Rotate secrets
  on personnel change or suspected leak; rotate the session secret with a
  maintenance window (sessions invalidate).
- Reboot behavior: Dokploy + DB restart on boot; app waits on readiness,
  not on fixed sleeps.
- **Garage runs in Swarm as a single node (NOT highly available).**
  The stack includes `feastjourney-garage:<sha>` (config-baked immutable
  image), pinned to the labeled durable-storage node with persistent
  `garage_meta` + `garage_data` volumes, S3 on `http://garage:3900`
  (internal overlay only, no public port). See [object storage](object-storage.md)
  and [ADR 0004](../decisions/0004-garage-swarm.md). Durability is the
  backup/restore procedure, not replication: daily encrypted off-host bundles
  + quarterly `--test` restore drills. If the drill has not passed, production
  readiness is UNVERIFIED.

### 9a. Dish photography: object storage and delivery (live consumer)

First-party dish photos (upload → review → publish) run against local
Garage in dev and Swarm Garage in staging/production (same `DishMediaStorage`
S3 adapter, same bucket layout, same same-origin delivery).

- Swarm prerequisites (operator, before first staging deploy): label one
  durable node (`docker node update --label-add feastjourney-storage=true`),
  fill Dokploy secrets (`GARAGE_RPC_SECRET`, `GARAGE_BOOTSTRAP_*`,
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, `S3_REGION`,
  `S3_BUCKET_PRIVATE`/`S3_BUCKET_MEDIA`), then provision the least-privilege
  app key with `infra/scripts/garage-provision.sh`. Missing prerequisites
  fail the deploy fast; existing objects are never silently replaced.
  Rollback = prior immutable `:sha-<SHA>` stack tag; volumes untouched.

- Object layout (bucket-configurable, default `feastjourney-private`):
  `dish-media/dishes/{dishId}/{mediaId}/{version}/{width}.webp`
  (opaque, versioned, immutable; 400/800/1600 WebP ~q80, originals never
  stored). Postgres `dish_media` holds only metadata (dims, format,
  checksum, license, attribution, review/publish timestamps).
- Delivery is same-origin streaming, not a public bucket:
  `GET /api/v1/dish-images/{mediaId}/{version}/{width}` serves
  published + ready derivatives only (`image/webp`, `Cache-Control:
  public, max-age=3153600, immutable`, ETag + 304). Drafts, review
  items, failed processing, stale versions, and bad widths all resolve
  to 404 without distinguishing; `?preview=1` serves ready rows to a
  signed-in `food:read` member (`private, no-store`). Place behind
  Cloudflare with edge caching when a production origin exists; the
  route needs no per-request re-encode and only one indexed row lookup
  per cache miss.
- New server env (shared names, never shared values; Swarm values come from
  Dokploy secrets, see `infra/.env.production.example`):
  `S3_ENDPOINT_INTERNAL` (`http://garage:3900` on both Compose and Swarm
  internal networks; host loopback only for local debugging), `S3_REGION`
  (`garage`), `S3_BUCKET_MEDIA` (defaults to `S3_BUCKET_PRIVATE`), plus
  least-privilege `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` for the app and
  separate `GARAGE_RPC_SECRET` / `GARAGE_BOOTSTRAP_*` for the Garage service.
  The app never exposes these to the browser; presigned browser upload URLs
  are not used. The Swarm app holds no admin/RPC credentials.
- Local-only operator note (2026-10-30): `infra/.env` S3 secrets were
  regenerated after the Garage bootstrap, so the stored default key no
  longer authenticated (`No such key`). A new local key
  (`feastjourney-app-local`, RW on `feastjourney-private`) was created
  via `garage key create` + `garage bucket allow`, and the ignored
  `infra/.env` was rotated to it (verified PUT/GET/DELETE round-trip).
  If local S3 auth breaks again, reissue the key administration-side —
  never paste secrets into logs, chat, or commits.

## 10. Admin bootstrap

`scripts/create-admin.ts` review (read-only finding): takes
`<email> <password>` as CLI args, requires shell + `DATABASE_URL`, creates
a verified owner + audit rows, has no HTTP path. Weakness: the password
travels via argv (shell history, process list). Changing the script is OUT
OF SCOPE for this workstream (`scripts/` not owned) — recommendation filed:
accept password from stdin (`--password-stdin`) or a `0600` secret file,
and refuse to run when `BETTER_AUTH_URL` is not the intended environment.

Secure procedure until then (authorized shell only, staging first):

1. SSH to the VM (or Dokploy exec into the app container with the app env).
2. Disable history: `set +o history` (bash) or prefix with a space (zsh
   with `HISTCONTROL=ignorespace`); never paste the password into chat,
   tickets, or CI logs.
3. Run with explicit env (example shape — values from the secret store):
   `BETTER_AUTH_URL=… DATABASE_URL=… bun scripts/create-admin.ts owner@example.org`
   then type/paste the password only if stdin support has landed, else pass
   it as the second arg in the history-disabled shell and clear it after.
4. Verify: sign in as that user, open Feast Lab (`/admin*` routes): owner
   sees administration; a fresh member gets denied (authz allow+deny pair).
   Confirm the `auth.role.changed … via: bootstrap-cli` row in
   `security_audit_events`. Record the bootstrap out-of-band.
5. Never: expose a public signup-to-admin endpoint, auto-run bootstrap on
   deploy, or reuse the staging password in production.

## 11. Verification

### Locally verified (disposable fresh PG18+PostGIS, loopback-only)

| Check | Command (repo root) | Result |
| --- | --- | --- |
| Fresh migrate | `compose … run --rm migrator` | 17 migrations applied, exit 0 |
| History valid | `… run --rm migrator validate` | validated, exit 0 |
| Types | `bun run check-types` | **FAIL — pre-existing breakage at this HEAD+worktree** (`admin.users.tsx` null errors, `admin-members-drawer.test.ts` Permission mismatch from concurrent edits; outside this workstream's owned paths) |
| Tests | `bun test tests/` | **205 pass / 155 fail** — same concurrent-edit breakage; failures cluster in admin/member suites, not in migration or health paths |
| Build | `bun run build` | exit 0, `.output/server/index.mjs` + `.output/public` emitted |
| Image build | `docker build -f infra/Dockerfile.prod -t feastjourney-prod:verify .` | exit 0 (50s); non-root `appuser`, no `.env`/`.git`/`infra`/fixtures in image |
| Runtime smoke | container on isolated disposable DB: `/health/live`, `/health/ready`, `/` SSR, static asset, `/sign-in` route, `/admin` deny-without-session, secret-absence in HTML, sanitized errors, restart persistence, failed-migration-blocks-rollout | `live` 200, `ready` 200 `{"status":"ready"}`; `/` SSR 200 (11 KB); asset 200; `/sign-in` + `/admin` 307 (guest guard → login); HTML secret-scan CLEAN; 404/400 bodies sanitized (`code` + `requestId`, no stacks); restart → ready 200; container HEALTHCHECK `healthy`; broken migration exits 1 while real history still validates |

Concurrent-edit note: three sibling agents edit `src/`/`tests/` while this
workstream runs. Above failures are theirs to fix; the release pipeline
fails closed on exactly these gates, which is the design working.

### UNVERIFIED — operator-side (explicitly not claimed)

Azure VM sizing/network, Dokploy install + Traefik routing, Postgres
topology choice + role DDL + backups/restore drill, GHCR push from CI,
tunnel route + `staging.feastjourney.world` DNS, Cloudflare Access service
token, Dokploy API path/params for the deploy step, SMTP deliverability,
Google/Facebook redirect-URI registration, NSG audit, admin bootstrap on
staging. Each has an owner and a checkbox in §12.

## 12. Human actions checklist

- [ ] **Git:** review this workstream's files only (`infra/Dockerfile.prod`,
  `.github/workflows/release.yml`, `infra/.env.production.example`, this
  runbook, index-line updates); confirm no `src/`/`tests/`/`db/`/
  `package.json`/local-compose changes; tag `v0.1.0-staging.1` to exercise
  the pipeline after sibling breakage is fixed and quality is green.
- [ ] **Dokploy:** create staging app (image `ghcr.io/<owner>/feastjourney`,
  port 3000, SHA pinning), pre-deploy one-shot Flyway job with migrator
  secrets, app service with app-role secrets; grace ≥ 30s; restart policy.
- [ ] **Postgres:** choose topology A/B; provision PG18+PostGIS; create
  schema + three roles; enable encrypted backups + retention; run a restore
  drill before first production data.
- [ ] **Cloudflare:** confirm tunnel route + DNS for staging origin;
  Access-protect Dokploy dashboard; mint the CI service token; verify
  `CF-Connecting-IP` reaches the app.
- [ ] **GitHub:** fill `staging` environment secrets (Dokploy URL/token/app
  id, Access service token); confirm `packages:write` only on publish;
  run dispatch with `deploy_staging=true` and watch readiness.
- [ ] **Azure:** NSG audit (no public 3000/5432), SSH key access only,
  disk sizing for volume growth, reboot behavior confirmed.
- [ ] **Post-deploy:** run §10 bootstrap on staging, verify allow+deny,
  test verify/reset emails, record RPO/RTO + rollback SHA.
