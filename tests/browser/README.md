# Private menu browser verification

`bun run test:browser` drives the actual built application, PostgreSQL and Garage.
Only Muse is replaced by `bun run test:menu-provider`, an explicit local TLS
contract fixture. The fixture validates multi-image requests and returns synthetic
Vietnamese menu data; it does not perform OCR or measure real extraction quality.

The runner refuses resources outside the task-owned loopback PostgreSQL port
55434 (`feastjourney_pr4_v2` database), Garage port 53904 and a localhost app URL.
Supply `DATABASE_URL`, `S3_ENDPOINT_INTERNAL`, `S3_REGION`,
`S3_BUCKET_PRIVATE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and synthetic
authentication environment settings. Migrate the disposable database with the
repository's Flyway history first. Never point these tests at existing user data.

For the provider fixture, generate a temporary self-signed certificate in `/tmp`
with SANs `DNS:localhost,IP:127.0.0.1`; set `MENU_FIXTURE_CERT` and
`MENU_FIXTURE_KEY` (defaults `/tmp/fj-pr4-browser-cert.pem` and
`/tmp/fj-pr4-browser-key.pem`). The provider listens only on 127.0.0.1:54444.
Configure the test app with:

```sh
export MENU_SCANNER_ENABLED=true
export MODEL_API_KEY=synthetic-browser-menu-key
export MODEL_BASE_URL=https://127.0.0.1:54444/v1
export BETTER_AUTH_URL=http://localhost:3104
export HOST=127.0.0.1
export PORT=3104
export RATE_LIMIT_PUBLIC=1000
export RATE_LIMIT_SEARCH=1000
export RATE_LIMIT_ADMIN=1000
export NODE_EXTRA_CA_CERTS=/tmp/fj-pr4-browser-cert.pem
export SSL_CERT_FILE=/tmp/fj-pr4-browser-cert.pem
```

Use synthetic OAuth/SMTP/session settings matching `tests/bootstrap.ts` for the
app and runner. Start the fixture, run `bun run build`, and start that built app
with `bun run start` in another terminal. Then run `bun run test:browser` with
the same disposable database/storage and session secret. A local Playwright
Chromium installation is required. No real Meta credentials are used.

The script exercises gallery multi-page management, extraction through the
actual adapter, corrections, variant quantities, exact and unknown totals,
keyboard waiter-dialog dismissal, narrow layout, foreign guest/photo denial,
unchecked contribution consent, rejection/correction/new-snapshot resubmission,
curator review and relational reuse without
another model call. A same-application account switch verifies explicit guest
claiming, private scan isolation and member currency preference isolation while
preserving the mounted QueryClient. It records synthetic screenshots under
`/tmp/fj-pr4-browser-evidence` and cleans only its tracked fixtures.

The runner passed locally on 2026-10-30 against the combined migrated schema,
real Garage and the built application. Muse was the synthetic contract fixture.
The guest ordering and review journeys were exercised at 320px/390px, including
keyboard dialog dismissal and focus restoration. This does not verify a live
Muse account, real extraction accuracy, physical camera permissions or a screen
reader. See [implementation status](../../docs/development/pr4-implementation-status.md)
for exact commands, limitations and current readiness.
