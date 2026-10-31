WITH input AS (
  SELECT :latitude::float8 AS lat,
    :longitude::float8 AS lon,
    :radius_m::int AS radius_m,
    :cuisine::nullable(text) AS cuisine,
    :excluded_ids::bigint[] AS excluded_ids,
    :locale::text AS locale,
    :meal::text AS meal
),
nearby_places AS (
  SELECT p.id AS place_id,
    ST_Distance(
      ST_MakePoint(p.display_longitude, p.display_latitude)::geography,
      ST_MakePoint(input.lon, input.lat)::geography
    ) AS dist_m
  FROM feastjourney.places AS p
  CROSS JOIN input
  -- Locality-only: city-scale placements count as nearby. Country, region,
  -- and continent centroids NEVER qualify — a country centroid hundreds of
  -- kilometers away must not relabel another region's dishes as local.
  WHERE p.display_latitude IS NOT NULL AND p.display_longitude IS NOT NULL
    AND p.kind = 'locality'
    AND ST_DWithin(
      ST_MakePoint(p.display_longitude, p.display_latitude)::geography,
      ST_MakePoint(input.lon, input.lat)::geography,
      input.radius_m
    )
),
dish_distances AS (
  SELECT dp.dish_id AS dish_id,
    MIN(nearby_places.dist_m) AS dist_m
  FROM feastjourney.dish_places AS dp
  JOIN nearby_places ON nearby_places.place_id = dp.place_id
  GROUP BY dp.dish_id
)
SELECT d.id::text AS id,
  d.slug AS slug,
  COALESCE(
    (
      SELECT dn.name
      FROM feastjourney.dish_names AS dn
      WHERE dn.dish_id = d.id AND dn.language_tag = input.locale
      ORDER BY dn.is_preferred DESC, dn.name ASC
      LIMIT 1
    ),
    (
      SELECT dn.name
      FROM feastjourney.dish_names AS dn
      WHERE dn.dish_id = d.id AND dn.language_tag = 'en'
      ORDER BY dn.is_preferred DESC, dn.name ASC
      LIMIT 1
    ),
    d.slug
  ) AS name,
  (
    SELECT dn.name
    FROM feastjourney.dish_names AS dn
    WHERE dn.dish_id = d.id AND dn.language_tag = 'en'
    ORDER BY dn.is_preferred DESC, dn.name ASC
    LIMIT 1
  ) AS "englishName",
  COALESCE(
    (
      SELECT array_agg(c.slug ORDER BY c.slug)
      FROM feastjourney.dish_cuisines AS dc
      JOIN feastjourney.cuisines AS c ON c.id = dc.cuisine_id
      WHERE dc.dish_id = d.id
    ),
    '{}'
  ) AS cuisines,
  COALESCE(
    (
      SELECT array_agg(c.slug ORDER BY c.slug)
      FROM feastjourney.dish_categories AS dc
      JOIN feastjourney.categories AS c ON c.id = dc.category_id
      WHERE dc.dish_id = d.id
    ),
    '{}'
  ) AS categories,
  LEFT(
    COALESCE(
      (
        SELECT COALESCE(dd.description, dd.summary)
        FROM feastjourney.dish_descriptions AS dd
        WHERE dd.dish_id = d.id AND dd.language_tag = input.locale
        LIMIT 1
      ),
      (
        SELECT COALESCE(dd.description, dd.summary)
        FROM feastjourney.dish_descriptions AS dd
        WHERE dd.dish_id = d.id AND dd.language_tag = 'en'
        LIMIT 1
      )
    ),
    500
  ) AS description,
  COALESCE(
    (
      SELECT array_agg(ranked.name)
      FROM (
        SELECT DISTINCT ON (di.ingredient_id) inm.name AS name
        FROM feastjourney.dish_ingredients AS di
        JOIN feastjourney.ingredient_names AS inm ON inm.ingredient_id = di.ingredient_id
        WHERE di.dish_id = d.id
          AND (inm.language_tag = input.locale OR inm.language_tag = 'en')
        ORDER BY di.ingredient_id ASC,
          CASE WHEN inm.language_tag = input.locale THEN 0 ELSE 1 END ASC
        LIMIT 20
      ) AS ranked
    ),
    '{}'
  ) AS "ingredientNames",
  d.updated_at AS "updatedAt",
  dish_distances.dist_m::float8 AS "nearbyDistanceM"
FROM feastjourney.dishes AS d
CROSS JOIN input
JOIN dish_distances ON dish_distances.dish_id = d.id
WHERE d.status = 'published'
  AND (
    input.cuisine IS NULL
    OR EXISTS (
      SELECT 1
      FROM feastjourney.dish_cuisines AS dc
      JOIN feastjourney.cuisines AS c ON c.id = dc.cuisine_id
      WHERE dc.dish_id = d.id AND c.slug = input.cuisine
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM feastjourney.dish_ingredients AS di
    WHERE di.dish_id = d.id AND di.ingredient_id = ANY(input.excluded_ids)
  )
-- Nearest association first, then the same cuisine/meal/id order the
-- country candidate query uses, so ranking stays stable across scopes.
ORDER BY
  dish_distances.dist_m ASC,
  CASE
    WHEN input.cuisine IS NULL THEN 1
    WHEN EXISTS (
      SELECT 1
      FROM feastjourney.dish_cuisines AS dc
      JOIN feastjourney.cuisines AS c ON c.id = dc.cuisine_id
      WHERE dc.dish_id = d.id AND c.slug = input.cuisine
    ) THEN 0
    ELSE 1
  END ASC,
  CASE
    WHEN input.meal = 'anything' THEN 1
    WHEN EXISTS (
      SELECT 1
      FROM feastjourney.dish_categories AS dc
      JOIN feastjourney.categories AS c ON c.id = dc.category_id
      WHERE dc.dish_id = d.id AND c.slug = input.meal
    ) THEN 0
    ELSE 1
  END ASC,
  d.id ASC
LIMIT :limit::int
