# FeastJourney

Mobile-first food discovery for travellers: find **what to eat**, find a **verified place** that serves it, and **read the menu + order** without speaking the language.

> **Live preview:** https://feastjourney.world

![FeastJourney home — globe hero with dish spotlight](docs/screenshots/homepage.png)

## What it does

A traveller landing in an unfamiliar food culture hits three walls: choosing a dish, trusting a place serves it, and decoding the menu at the table. FeastJourney answers each one, and says so honestly when it cannot verify something.

**1. Discover what to eat** — a short quiz (region → meal/mood → exclusions) picks from a curated public catalog, or browse the discovery carousel. Muse optionally re-ranks the already-eligible matches; without a model key the deterministic baseline is served and labeled as such.

![Dish quiz, step 1](docs/screenshots/quiz.png)

![AI-ranked recommendations](docs/screenshots/quiz_result_ai.png)

![Discovery carousel](docs/screenshots/discovery.png)

**2. Find a verified place** — map-first restaurant search (PostGIS + MapLibre) over venues with approved serving evidence. Dish pages link to places that serve them; venue pages link back to menus, reviews, scan, and directions. A translated name is never presented as proof a dish is served.

![Dish detail with ingredients and places](docs/screenshots/dish_detail.png)

![Restaurant map search](docs/screenshots/map.png)

![Venue menu highlights with prices](docs/screenshots/price_display.png)

**3. Understand the menu and order** — photograph a menu and Muse extracts items, variants, prices, and translations with per-field uncertainty (uncertain fields stay null, never invented). Correct the draft, build quantities, and show a bilingual waiter card with an estimated subtotal — an estimate to show staff, nothing is ever submitted.

![Menu scan with Muse](docs/screenshots/menu_scan2.png)

Reviews are summarized the same honest way — what travelers highlight, what is frequently praised, and what is worth knowing:

![AI review summary on mobile](docs/screenshots/mobile_ai_review_summary.png)

**Mobile-first** — the home page ships a dedicated mobile shell (stage + bottom sheet + persistent globe), and recommendations work the same in a pocket viewport:

| Mobile home | Mobile recommendations |
|---|---|
| ![Mobile home](docs/screenshots/mobile_homepage.png) | ![Mobile recommendations](docs/screenshots/mobile_food_recommendation.png) |

## Try it

- **Preview deployment:** https://feastjourney.world
- Routes worth clicking: `/` (quiz + discovery), `/dishes/$dishId` (dish detail), `/restaurants` (map search), `/scan` (menu scanner), `/muse` (dining copilot), `/saved` (members).

## Run locally

Prerequisites: [Bun](https://bun.sh/) 1.4.4 (verified), Docker + Compose plugin, `openssl` for secret generation.

### 1. Configure the environment

```sh
cp .env.example .env
# Fill in real values. At minimum generate the session secret:
# openssl rand -base64 32  # -> BETTER_AUTH_SECRET
```

Startup validates configuration and fails fast on missing values (see `src/server/env.ts`); the full variable contract is in `docs/infra/environment.md`. The landing page needs no database, but catalog, auth, and admin flows need PostgreSQL with all migrations applied.

### 2. Start infrastructure and migrate

```sh
cp infra/.env.example infra/.env
docker compose --env-file infra/.env -f infra/compose.yaml -f infra/compose.ports.yaml up -d --wait postgres
docker compose --env-file infra/.env -f infra/compose.yaml -f infra/compose.ports.yaml run --rm migrator
docker compose --env-file infra/.env -f infra/compose.yaml -f infra/compose.ports.yaml run --rm migrator validate
```

The `compose.ports.yaml` overlay publishes PostgreSQL on loopback-only `127.0.0.1:5433` so host-side tooling (Reylo type analysis, tests, production build) can reach the migrated database. The base Compose file alone intentionally exposes no database port.

Email-dependent flows (sign-up verification, password reset) need an SMTP server. For local development, point the `SMTP_*` values at Mailpit:

```sh
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
# read captured mail at http://localhost:8025
```

Without a reachable SMTP server the app still starts and public discovery works, but verification and reset emails fail at send time.

### 3. Install, develop, verify

```sh
bun install --frozen-lockfile
export DATABASE_URL="postgres://feastjourney:fj-local-dev-pw@127.0.0.1:5433/feastjourney"  # must match infra/.env
bun run dev
# → http://localhost:3000
```

```sh
bun run check        # format + lint + Reylo-aware typecheck (needs DATABASE_URL)
bun test tests/      # unit + integration (needs the migrated database)
bun run build
bun run start
```

The default production build targets Bun. For Node, rebuild with `bun run build:node` and run `bun run start:node`. Both outputs use `.output/`, so rebuilding replaces the previous target. Configure the listening address with `HOST` and `PORT`.

Create the first administrator directly (shell + DB access required; not reachable over HTTP — the account is created verified and granted the protected owner role):

```sh
bun scripts/create-admin.ts admin@example.com 'strong-password-min-12-chars'
```

### Fully containerized dev loop (optional)

`bun run dev:docker` starts the whole stack from one command — Vite dev server with hot reload (bind-mounted source), PostgreSQL, the one-shot Flyway migrator (the app waits for its successful exit), and Garage:

```sh
bun run dev:docker
# → app on http://localhost:3000
```

Only the application port is published, bound to loopback (`127.0.0.1:3000`). If port 3000 is occupied, set `APP_DEV_PORT=3001` in `infra/.env` and `BETTER_AUTH_URL=http://localhost:3001` in the root `.env`.

## Tech stack

| Layer | Choice |
|---|---|
| App | TanStack Start (React) + Effect v4 operations, modular monolith — no separate HTTP backend |
| Data | PostgreSQL 18 + PostGIS 3.6 (relational truth), Flyway one-shot migrations, Reylo typed SQL |
| Objects | S3-compatible store (Garage locally); Postgres owns metadata and permissions, never the reverse |
| Auth | Better Auth (email + Google/Facebook OAuth), DB-backed RBAC, member-owned data gated per operation |
| Map | Browser-only MapLibre GL JS + `react-map-gl/maplibre`; tiles are a basemap, not a place source |
| AI | Muse (`muse-spark-1.3`): dish re-ranking, menu extraction, review summarization — each bounded, labeled, with deterministic fallbacks |

## Trust and safety

AI-generated food, allergy, ingredient, and price claims are **unverified unless backed by evidence**: eligibility runs in SQL before any model sees it, uncertain scan fields stay null with an explicit uncertainty entry, private scans expire after 24 hours, and reviewer approval is a separate audited step. See `docs/architecture/restaurant-discovery.md`.

## Docs

Start with `AGENTS.md`, then `docs/README.md` (index). Key entries:

- `docs/architecture/overview.md` — request flow, module boundaries
- `docs/infra/operations.md` — local runbook and smoke checks
- `docs/infra/environment.md` — configuration contract
- `docs/architecture/recommendations.md` — quiz pipeline and Muse ranking rules
- `docs/hackathon/project-summary.md` — problem framing and demo narrative
- `docs/development/quality-gates.md` — checks required before calling work ready

Source references are collected in `docs/references.md`.
