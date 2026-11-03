# Database and migration verification

## Layers of evidence

| Check | What it establishes | What it does **not** establish |
| --- | --- | --- |
| `docker compose ... config --quiet` | Compose config interpolates/parses | Image exists, Postgres starts, Flyway works |
| Flyway `migrate` on **fresh Postgres 18** | Ordered schema can be installed | App queries are semantically correct |
| Flyway `validate` | Recorded versions/names/checksums consistent | Safe data changes or query performance |
| Re-run Flyway `migrate` | Pending versioned migrations settle to no-op | Repeatable migrations always harmless |
| Reylo TypeScript check | Query and inferred row types fit the migrated schema | AI facts or user ownership are correct |
| PostgreSQL integration tests | Transaction behavior, constraints, query results | Production concurrency/performance automatically proven |
| App build + browser checks | Bundling and user flows | Migrations and operations safe on existing production data |

## Required test scenarios when schema/code arrives

1. Fresh-database migration: migrate all files in order into schema `feastjourney`, validate, ensure the PostGIS extension and `ST_DWithin` function work, and record history versions.
2. Upgrade-path test: start from previous deployed schema and verify migrations apply without deleting user data or breaking older deployed readers during rollout.
3. Query shape and invariants: PK/unique nullability, missing rows, foreign keys, under/over-limit pagination, Unicode food names, source/evidence nullability.
4. Actor access: guest public discovery works; private tables reject guest reads/writes; member A cannot access member B's saved items, including through bulk operations.
5. Transactionality: one cross-domain change succeeds atomically, failing the second step leaves no partial commit; pool client is released on error/interruption.
6. Concurrency: duplicate saves/idempotency, competing updates, and uniqueness violations have defined outcomes.
7. Negative provider cases: untrusted menu/AI output cannot become confirmed ingredient or restaurant-offering facts; SQL typing alone does not cover this.
8. Migration evolution: checksum mismatch rejects changed applied migration; destructive/long-running changes include rollback/compatibility approval.

## CI sequencing

The `Quality` workflow's `backend` job provisions a fresh, disposable
PostgreSQL 18 instance, runs **all** migrations in version order, runs Flyway
`validate`, then type-checks Reylo `.sql` imports, runs unit and integration
tests, and builds the production bundle — all against the same migrated
database. It fails when the database is unavailable or a migration is
unapplied. Green builds based solely on a stale `.reylo/` cache are
disallowed: Reylo re-analyzes changed statements against the live schema and
fails closed without it.

The same `backend` job also provisions a disposable single-node Garage
(`dxflrs/garage:v2.5.0`) next to PostgreSQL and exports loopback S3 variables
(`S3_ENDPOINT_INTERNAL=http://127.0.0.1:3900`, region `garage`, bucket
`feastjourney-private`, generated `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY`) to every later step via `$GITHUB_ENV`. The committed
`infra/.env.example` placeholders are not valid Garage credentials, so the job
replaces them with `openssl rand`-generated values before
`compose up -d --wait postgres garage`. A bounded `garage-s3-check.mjs`
readiness probe (PUT/HEAD/GET plus anonymous/bogus denial and DELETE) fails
the job fast when the store is unreachable, instead of surfacing as dozens of
storage-suite failures. The full `bun test --isolate tests/` run then
exercises the real storage-backed suites (menu scan promotion/hardening,
garage S3 round-trip, restaurant-photo adapter) against these disposable
services; suites without S3 configuration fail closed rather than silently
skipping.

Keep database test fixtures synthetic and disposable; never use user photographs, real account tokens or production credentials. Use PostgreSQL for query tests rather than mocking SQL semantics.

Integration tests refuse to run unless `DATABASE_URL` points at the disposable loopback `feastjourney` test database. The guard lives in `tests/bootstrap.ts`, which Bun preloads before any test module evaluates (`bunfig.toml` `[test] preload`), so static application imports can never observe an unconfigured environment regardless of file order; `tests/integration/cleanup.ts` keeps per-suite fixture tracking plus the same guard as a fallback.

## Developer loop

```bash
# Garage placeholders in infra/.env are not valid credentials: replace them
# with disposable generated values (never commit, never log the secret).
RPC_SECRET="$(openssl rand -hex 32)"
APP_ID="GK$(openssl rand -hex 16)"
APP_SECRET="$(openssl rand -hex 32)"
sed -i "s/^GARAGE_RPC_SECRET=.*/GARAGE_RPC_SECRET=${RPC_SECRET}/" infra/.env
sed -i "s/^S3_ACCESS_KEY_ID=.*/S3_ACCESS_KEY_ID=${APP_ID}/" infra/.env
sed -i "s/^S3_SECRET_ACCESS_KEY=.*/S3_SECRET_ACCESS_KEY=${APP_SECRET}/" infra/.env
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait postgres garage
docker compose --env-file infra/.env -f infra/compose.yaml run --rm migrator
docker compose --env-file infra/.env -f infra/compose.yaml run --rm migrator validate
# Host-side tooling and storage-backed tests reach the disposable services on
# loopback (add -f infra/compose.ports.yaml to the commands above for host
# port access). Never point these at existing user data.
export DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5433/feastjourney
export S3_ENDPOINT_INTERNAL=http://127.0.0.1:3900 S3_REGION=garage
export S3_BUCKET_PRIVATE=feastjourney-private S3_BUCKET_MEDIA=feastjourney-private
export S3_ACCESS_KEY_ID=<generated above> S3_SECRET_ACCESS_KEY=<generated above>
S3_ENDPOINT=http://127.0.0.1:3900 S3_BUCKET=feastjourney-private node infra/scripts/garage-s3-check.mjs
bun run check-types
# --isolate is mandatory, not optional:
# tests/admin-places-routing.test.ts stubs @tanstack/react-router via
# mock.module, which is process-persistent in bun 1.4.4 (mock.restore() does
# not clear it). Without per-file isolation the venue component suites fail
# with router.routesById TypeErrors.
bun test --isolate tests/
```

The Compose network deliberately exposes **no PostgreSQL port to the host**. Until an intentional loopback-only forwarding strategy or a containerized typecheck is implemented, running `bun run check-types` directly on the host with live `.sql` imports requires explicit access to the database; do not promise it will work by default. Document the chosen access mechanism with the application scaffold.

This document describes **required scenarios**, not an already-implemented or passing test suite.

## Geospatial tests (once restaurant schema exists)

Test strict coordinate/radius bounds, venue inclusion/exclusion at the edge of the radius, null/missing coordinates, stable ordering and spatial-index use. Browser-test TanStack SSR-safe MapLibre mounting, map/list selection, narrow/mobile scrolling, missing-location permission and map attribution. See `docs/architecture/maps.md`.
