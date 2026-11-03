# ADR 0006 — Third-party POI ingestion for Restaurant Discovery

- **Status:** Proposed
- **Date:** 2026-10-31

## Context

Restaurant Discovery returns zero venues in development because no
restaurant records exist. Investigation (2026-10-31, disposable check via
`infra-postgres-1`):

- `feastjourney.restaurant_venues`: 0 rows; `restaurant_eligible_evidence`: 0 rows.
- `feastjourney.dishes`: 13 rows including `pho`, `pho-bo`, `pho-ga`.
- `feastjourney.places`: 262 geographic identities (continents, countries,
  localities). These are dish geography, not restaurant POIs.
- `VITE_MAP_STYLE_URL` is unset in the local environment, so the map
  renderer correctly falls back to list-only with an explicit diagnosis.

The map rendering system does not supply a restaurant catalog. Basemap
tiles, real-world POI datasets, FeastJourney venue records, and reviewed
dish/menu evidence are four distinct layers and must stay distinct.

## Decision

Use **Overture Maps Places** as a candidate licensed POI source for
backfilling venue candidates, ingested exclusively through the existing
administrative dataset-import pipeline
(`restaurant-import.schema.ts` + `venue-bulk-import.ts` +
`/admin/restaurant-imports` wizard). No automatic venue creation from
tiles, geocoding, names, or cuisine labels.

- Source identity: `sourceName: "Overture Maps Places"`,
  `sourceRecordId`: stable Overture `id`, `datasetVersion`: Overture
  release (for example `2026-10.0`), `license: "other"` (forces manual
  review; Overture CDLA/data-license terms require attribution and reuse
  review before apply), `attribution`: Overture attribution text.
- Identity and dedup: exact normalized name + address match auto-skips as
  duplicate; fuzzy trigram candidates within 50 m go to `needsReview`.
  The wizard never auto-merges. Applied rows insert as `status: 'draft'`;
  publication remains a separate curator review.
- Provenance: per-row `restaurant_sources` rows with
  `category: 'authorized_provider'`, `restaurantVerified: false`,
  observation/validity window, dedup key
  `sourceName:datasetVersion:sourceRecordId`. No imported row is
  automatically declared verified.
- Serving evidence: never infer that a venue serves a canonical dish from
  its name or cuisine. Dish links require a reviewed menu import plus an
  approved `exact`/`variant` serving-evidence observation. Suggestions and
  cuisine labels are not serving evidence.
- UI honesty: general nearby restaurants and dish-verified restaurants are
  labeled separately. A dish with zero verified matches keeps an
  interactive map and offers an explicit "Browse nearby restaurants"
  action that clears only the dish filter and never implies those places
  serve the dish.

## Alternatives considered

- **Manual entry only:** highest provenance quality, but cannot bootstrap
  a usable map for a city without unreasonable curator labor.
- **Google Places / Foursquare live API as primary catalog:** vendor
  billing, key management, and terms make them unsuitable as the stored
  source of truth; they remain candidates for future licensed refresh only.
- **OSM raw POI scrape:** license-compatible with attribution, but quality
  and stable identities are weaker than Overture's conflated release for
  this use case.
- **Inferring dish availability from names/cuisines:** rejected. It would
  fabricate serving claims and dietary-relevant facts.

## Consequences / future work

- Add an Overture-specific import template and a worked example mapping
  Overture fields to the existing CSV/JSON header vocabulary
  (`businessName`, `name`, `address`, `area`, `countryCode`, `longitude`,
  `latitude`, `cuisineSlugs`, `sourceRecordId`, `observedAt`,
  `datasetVersion`).
- Persist the external source record identity per venue (currently echoed
  in apply provenance and audit metadata, not in a dedicated venue
  column). A forward migration should add a nullable external-identity
  table or columns with a uniqueness guard, without editing applied
  migrations.
- License review with counsel before any bulk Overture apply; record the
  release version and attribution in the dataset provenance.
- Seed only synthetic, clearly labeled demo venues for local UI
  verification; never commit fabricated menus, prices, or dietary
  guarantees as production data.

See `docs/architecture/maps.md` (tiles are not data),
`docs/architecture/restaurant-discovery.md` (evidence and pricing),
and `docs/decisions/0002-postgis-and-maplibre.md` (map vs POI datasets).
