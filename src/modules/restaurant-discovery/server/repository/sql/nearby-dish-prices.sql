-- Batched nearby price candidates for up to twelve dishes at one origin.
--
-- One candidate pool, no per-dish round trips: published venues within the
-- widest radius (40km, see NEARBY_PRICE_RADII_KM in nearby-price.ts) plus,
-- when a city place is requested, published venues whose stored area
-- exactly matches a registry name of that city locality. Radius filtering
-- uses ST_DWithin on the geography GiST index; the area predicate matches
-- the partial lower(area) index.
--
-- Serving and price semantics mirror search-dish.sql: published
-- venue/menu/item/variant statuses, approved serving evidence with
-- e.match_kind NOT NULL via restaurant_eligible_evidence, and the selected
-- price for the requested channel where price_eligible means a listed,
-- current-enough observation. The city join is registry-verified area-name
-- membership only: places carry display-only coordinates, never boundary
-- polygons, so no radius around a city placement may pose as city scope.
-- Dishes with no candidate venue still emit one sentinel row (NULL venue)
-- carrying the city resolution, so the operation can answer every dish.
WITH input AS (
  SELECT :longitude::float8 AS longitude,
    :latitude::float8 AS latitude,
    :channel::text AS channel,
    :city_place_id::nullable(bigint) AS city_place_id
),
origin AS (
  SELECT public.ST_SetSRID(public.ST_MakePoint(i.longitude, i.latitude), 4326)::public.geography AS geo
  FROM input i
),
dishes AS (
  SELECT DISTINCT unnest(:dish_ids::bigint[]) AS dish_id
),
city AS (
  SELECT p.id AS place_id, pref.name AS label
  FROM input i
  JOIN feastjourney.places p ON p.id = i.city_place_id AND p.kind = 'locality'
  JOIN feastjourney.place_names pref ON pref.place_id = p.id AND pref.language_tag = 'en' AND pref.is_preferred
),
venues AS (
  SELECT v.id, v.business_id, v.name, v.area, v.country_code,
    v.longitude AS longitude, v.latitude AS latitude,
    public.ST_Distance(v.location, o.geo) AS distance_meters,
    EXISTS (
      SELECT 1
      FROM city c
      JOIN feastjourney.place_names n ON n.place_id = c.place_id AND n.language_tag = 'en'
      WHERE lower(v.area) = lower(n.name)
    ) AS in_city
  FROM feastjourney.restaurant_venues v
  CROSS JOIN origin o
  CROSS JOIN input i
  WHERE v.status = 'published'
    AND (
      public.ST_DWithin(v.location, o.geo, 40000)
      OR (
        i.city_place_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM city c
          JOIN feastjourney.place_names n ON n.place_id = c.place_id AND n.language_tag = 'en'
          WHERE lower(v.area) = lower(n.name)
        )
      )
    )
),
offerings AS (
  SELECT d.dish_id, v.id AS venue_id, v.name AS venue_name,
    v.longitude AS longitude, v.latitude AS latitude,
    v.distance_meters AS distance_meters, v.in_city AS in_city,
    e.evidence_tier AS evidence_tier,
    i.id AS item_id, vr.id AS variant_id, vr.name AS variant_name, vr.comparison_key AS comparison_key,
    p.amount AS amount, p.currency AS currency, p.tax_treatment AS tax_treatment,
    p.observed_at AS price_observed_at,
    LEAST(p.review_after, s.valid_until) AS price_valid_until,
    COALESCE(p.current_enough AND p.price_kind = 'listed', FALSE) AS price_eligible
  FROM venues v
  JOIN feastjourney.restaurant_menu_items i ON i.venue_id = v.id AND i.status = 'published'
  JOIN feastjourney.restaurant_menus m ON m.id = i.menu_id AND m.status = 'published'
  JOIN feastjourney.restaurant_eligible_evidence e ON e.menu_item_id = i.id
  JOIN dishes d ON d.dish_id = e.dish_id
  JOIN feastjourney.restaurant_menu_item_variants vr ON vr.menu_item_id = i.id AND vr.status = 'published'
  CROSS JOIN input f
  LEFT JOIN feastjourney.restaurant_selected_prices p ON p.variant_id = vr.id AND p.sales_channel = f.channel
  LEFT JOIN feastjourney.restaurant_sources s ON (s.id, s.venue_id) = (p.source_id, p.venue_id)
  WHERE e.observed_at IS NOT NULL AND e.match_kind IS NOT NULL
),
chosen AS (
  SELECT DISTINCT ON (o.dish_id, o.venue_id) o.*
  FROM offerings o
  ORDER BY o.dish_id, o.venue_id,
    o.price_eligible DESC,
    o.evidence_tier,
    o.distance_meters,
    o.price_observed_at DESC NULLS LAST,
    o.variant_id
)
SELECT d.dish_id::text AS dish_id,
  (SELECT c.label FROM city c) AS city_label,
  EXISTS (SELECT 1 FROM city) AS city_resolved,
  o.venue_id AS venue_id, o.venue_name AS venue_name,
  o.longitude AS longitude, o.latitude AS latitude,
  o.distance_meters AS distance_meters, o.in_city AS in_city,
  o.item_id AS item_id, o.variant_id AS variant_id, o.variant_name AS variant_name,
  o.comparison_key AS comparison_key,
  o.amount AS amount, o.currency AS currency, o.tax_treatment AS tax_treatment,
  o.price_observed_at AS price_observed_at,
  o.price_valid_until AS price_valid_until,
  o.price_eligible AS price_eligible
FROM dishes d
LEFT JOIN chosen o ON o.dish_id = d.dish_id
ORDER BY d.dish_id, o.distance_meters, o.venue_id;
