# FeastJourney — architecture (hackathon)

Implemented-code data flow only. Every edge below names a real file,
table, or documented contract in this worktree. Nothing here assumes
unshipped P0 work (model-chip read path, extraction tightening).

```text
Browser (React + MapLibre GL, no DB/S3/secret access)
  │  TanStack Start server functions (Zod 4.6 in, explicit outcomes out)
  │    recommendDishesFn · getRestaurantFn · scan HTTP boundary (scan-http.ts)
  ▼
Effect v4 operations (typed failures, per-request Actor, no global runtime)
  ├── Meta API (server-only MODEL_* env, standard muse-spark-1.3)
  │     meta-client.ts        → ranking re-order only (≤10 candidates)
  │     muse-menu.ts          → menu extraction (strict JSON, store:false)
  ├── PostgreSQL + PostGIS (Reylo .sql, Flyway history, per-module repos)
  │     dishes / places / ingredients      (food-discovery catalog)
  │     venues (geography) / menus / items / variants / prices (NUMERIC)
  │     serving evidence (approved exact/variant only for dish search)
  │     reviews (published-only reads) · FX cache · RBAC tables
  │     menu_scan_* (private JSONB drafts, revisions, contributions)
  └── Garage S3 (server-side AWS SDK; browsers never sign URLs or use CORS)
        menu/{session-id}/{uuid} photo objects, checksum-verified,
        24 h expiry (30 d after consented submission)
  ▼
Editorial pipeline (/admin/restaurants, restaurant:manage + restaurant:review)
  contribution → reviewer inspects photos/revision/uncertainty/prices
  → one locked promotion transaction reuses import/observation/review ops
  → approved rows become published truth; drafts stay invisible
```

## Boundary rules (enforced, not aspirational)

- Browser code never imports DB, secrets, or object SDKs.
- Server functions validate every external input and authorize
  protected operations at the server boundary; route guards are
  navigation hints, never authorization
  (`docs/architecture/access-control.md`).
- SQL runs before any model call completes: candidates first, then at
  most one bounded Muse request; no transaction is held across it.
- Model output is untrusted: shape/money/currency/asset-membership
  validated at the AI trust boundary; no freeform repair chain, no
  model-generated executable UI.
- Published vs private is structural: published reads never touch
  `menu_scan_*` drafts; private scans never leak into published
  tables without reviewer promotion.
- Basemap tiles, POI datasets, venue records, and reviewed dish/menu
  evidence are four distinct layers (ADR-0002, ADR-0006). The map
  renderer never invents a restaurant catalog.

## Trust surfaces for the demo

| Surface | Implementation |
|---|---|
| Ranking honesty | `mode` is the single branding source of truth; `DegradedMuse` says AI ranking was unavailable instead of passing as catalog order (`quiz-status.tsx:107-178`) |
| Scan uncertainty | Per-field nulls + `uncertainties` list; printed vs inferred ingredients labeled; waiter card carries private/unverified notices (`menu-copy.ts`) |
| Money honesty | Variants carry exact amounts or explicit unknown; subtotal requires one currency and complete prices, else an unavailable-subtotal state; taxes/fees never inferred |
| Review honesty | Write path requires sign-in with venue-preserving `returnTo`; pending reviews invisible in published reads; removed rows redacted, never restored silently |
| Failure honesty | Typed failures (unavailable, expired, conflict, auth) with retry/return actions; no stack traces to the client |

## What this diagram excludes

- Live Muse behavior (accuracy, latency, cost): unmeasured.
- Model-chip read path: `scanModelChip` renders only when a `model`
  field arrives on the scan view; `scanViewSchema` /
  `scan-owned.sql` carry no such field yet, so the chip renders
  nothing today (P0 in-flight, not claimed).
- Raster live-eval fixtures, zero-retention guarantees beyond our own
  storage, and any unshipped seed/import tooling.
