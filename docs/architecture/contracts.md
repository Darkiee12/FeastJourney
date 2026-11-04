# Cross-module contracts

A module exposes only the smallest necessary public server operations through `src/modules/<module>/server/index.ts`. Other modules and workflows must not import its private repository, SQL, or operations implementation files.

Direct one-way calls are permitted; cyclic dependencies are not. A workflow under `src/server/workflows/` coordinates use cases spanning Food Discovery, Restaurant Discovery and User. Domain modules do not need a wrapper interface for every simple function; use meaningful Effect services at external/resource boundaries.

**Core example:** Food Discovery returns dish identities and food details; Restaurant Discovery takes identifiers/criteria and returns places plus *sourced serving evidence*; an orchestration workflow combines results, optionally informed by member preferences. It must not turn inferred matches into confirmed restaurant menu facts.

## Implemented catalog contracts (Food Discovery)

Public read operations (`DishService`, `CatalogService`) serve guests and members:

- `searchDishes`: multilingual text search with deterministic tier ranking, or
  faceted filtering (ingredients any/all, categories any/all, place subtree,
  cuisine, association), plus recency-browsed keyset pagination. Cursor
  payloads differ per sort, so cursors must never cross sort modes.
- `getDish`: accepts a decimal ID **or** canonical slug and returns the
  composed catalog profile (`id`, `slug`, localized `name`,
  `english_name`, `native_names`, localized `description`, ingredients,
  places with association/kind/ISO/display coordinates, cuisines, categories,
  `sources`, Unix-second `last_update`). IDs are strings at the HTTP boundary;
  raw `bigint` is never serialized.
- `getRelated`: sibling variants and categorically/geographically similar
  published dishes, ranked by shared relations.
- `listPlaces` returns places plus parent edges (hierarchy built client-side);
  `searchPlaces` resolves names in supported languages.
- `listCountries` returns only kind=`country` places with verified ISO 3166
  identity for the recommendation region step; filtering happens in SQL
  before the limit so no eligible country can hide behind other places.
- Member saved dishes: `listFavorites` (paged enumeration, limit+offset),
  `favoriteStatus` (membership probe for exactly the visible dish ids, so
  cards stay correct at any saved total), `addFavorite`/`removeFavorite`
  (idempotent conflicts surfaced as `FavoriteExists`/`FavoriteNotFound`).

Administrative writes (`AdminService`) require a verified session whose
database grants cover the operation (see `access-control.md` for the
permission map); the legacy `x-admin-key` path was removed and there is no
machine identity:

- `createDish`: slug optional (generated from the display name with collision
  suffixes); duplicate slugs conflict instead of merging.
- `updateDish` / `updateDishStatus`: publishing runs server-side validation
  (preferred English name, category, description or summary); failures return
  `InvalidDishData` with explicit reasons rather than partial writes.
- Translation, description, ingredient/place/category/cuisine links, each of
  which records a `catalog_revisions` row in the same transaction.
- `CurationService`: `validatePublication`, `recordRevision`, curation notes
  (`review`/`correction`/`question`), revision inspection, and the review
  queue over `review`-status dishes.
- `CatalogImportService.validateImport`: parses and validates an
  Effect-Schema-checked authoring payload, resolves ingredients/places/
  cuisines/categories against canonical records, flags possible duplicates
  for human review, and stages the job plus per-record results **without**
  applying anything. `applyImport` only runs `validated` jobs, applying each
  valid record in its own transaction and recording revisions and notes.
  Unknown references invalidate the record; slugs that collide are skipped,
  never merged.

Before implementing a public operation, specify:
- owning module, callers and observable user outcome;
- typed input, result and expected errors;
- whether it is `public`, `member`, or member-owned, and where authorization occurs;
- source/evidence and uncertainty required for restaurant, menu and ingredient claims;
- external dependencies, retries, cancellation, transaction and idempotency behavior;
- one guest/member test and one missing/contradictory-data test when relevant.

Define multi-case domain outcomes with Effect's `Data.TaggedEnum` (or `Schema.TaggedUnion` where true codec support is necessary) rather than arbitrary stringly typed `kind` payloads. Use `Data.TaggedError`/`Schema.TaggedError` for typed failures and `Effect.catchTag` at appropriate boundaries. A trusted `Actor` is provided from the verified session, never a decoded client choice. See [domain modeling](domain-modeling.md) and [access control](access-control.md).

Public recommendation outcomes (`Ready` with dishes + ranking mode, `Uncertain`, `Empty`) follow the same rule: the service returns the tagged union and the transport maps it to `{mode, dishes, warnings, reasons}`. The `mode` field tells clients exactly which path produced the result (`ai`, `deterministic`, `uncertain`, `empty`) — a deterministic fallback is never labeled as AI output.

Do not expose raw SQL/driver exceptions through RPC. Translate expected Effect failures to client-safe outcomes at the transport edge.

Database contracts: Flyway owns all ordered DDL in `db/migrations/`; every domain owns its Reylo query files under `server/repository/sql/`. Typed query results do not replace business invariants or evidence provenance checks. Read `docs/architecture/persistence.md` before adding database layers or a repository facade.

For multi-module atomic writes, the coordinating workflow establishes a single transaction scope and supplies the same transaction-bound client to participating repositories. Each module retains ownership of its data and validation rules.

## Private menu price observations

Menu scans retain four independent facts: verbatim `rawText`, nullable exact-decimal `amount`, nullable ISO `currency` with provenance, and item/variant `association`. Missing currency never discards readable text or an independently interpretable amount. Clear K notation expands exactly using BigDecimal; ambiguous separators remain unresolved. Optional `unit` and item `section` preserve supported serving qualifiers and printed headings. Provider strict output requires these nullable fields; historical stored revisions may omit them.

Printed currency outranks location. Published linked-venue country outranks the explicitly selected menu city resolved through the public place registry. Translation language and coarse visitor country do not establish menu currency. Muse may interpret credible printed addresses, with inferred currency still labeled as inferred. Deterministic shorthand recovery currently infers VND only with Vietnam menu-country evidence; other currency interpretation remains provider-supported or user-confirmed.

The results projection recovers clear numeric notation in historical observations without rewriting saved revisions. Currency confirmation saves a normal private customer revision with the existing expected-revision and ownership checks, preserving raw evidence. Bulk confirmation skips printed currencies, ambiguous/unavailable associations, conflicting inferred currencies, and observations containing unresolved currency symbols/codes. Those require individual correction. Subtotals and FX require usable exact amounts, currencies and clear associations; no rates or zero amounts are fabricated.

Results keep browsing, item detail, correction and order review as separate surfaces. Menu selections survive saved corrections when variant identities still exist. Public geographic selectors use the country registry and city search; selecting another country invalidates the city. Research remains explicit, unverified, and separate from printed menu prices and contribution consent.
