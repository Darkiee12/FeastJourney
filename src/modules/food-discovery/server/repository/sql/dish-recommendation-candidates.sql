WITH RECURSIVE input AS (
  SELECT :cuisine::nullable(text) AS cuisine,
    :country::nullable(text) AS country,
    :excluded_ids::bigint[] AS excluded_ids,
    :locale::text AS locale,
    :meal::text AS meal
),
-- Country subtree: the country place itself plus every descendant through
-- place_parents (state -> city). A Bengaluru-tagged dish is eligible when
-- browsing India without duplicating the association as a country row.
country_tree(id) AS (
  SELECT p.id AS id
  FROM feastjourney.places AS p
  CROSS JOIN input
  WHERE input.country IS NOT NULL AND p.iso3166 = input.country
  UNION
  SELECT pp.place_id AS id
  FROM feastjourney.place_parents AS pp
  JOIN country_tree AS t ON t.id = pp.parent_place_id
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
  d.updated_at AS "updatedAt"
FROM feastjourney.dishes AS d
CROSS JOIN input
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
  AND (
    input.country IS NULL
    OR EXISTS (
      SELECT 1
      FROM feastjourney.dish_places AS dp
      JOIN country_tree AS t ON t.id = dp.place_id
      WHERE dp.dish_id = d.id
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM feastjourney.dish_ingredients AS di
    WHERE di.dish_id = d.id AND di.ingredient_id = ANY(input.excluded_ids)
  )
-- Relevance-aware stable order mirroring rankDeterministic in
-- recommendation-service.ts: cuisine match first (when requested), then
-- meal-category match ("anything" skips), then id ASC. No ORDER BY random:
-- the candidate window must be deterministic across seed changes.
ORDER BY
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
