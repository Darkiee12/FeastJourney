-- Admin place listing: kind filter, direct-parent filter, and multilingual
-- name search over one page. The query is tokenized on spaces (after the
-- shared search-key normalization): every token must appear as a substring
-- of the same name row, so `Listville 2024` matches `Listville Alpha 2024`
-- but not `Listshire 2024`. An empty query matches every place. The parent
-- filter selects direct children of one place only. The preferred English
-- name is projected for chooser display; places without one report a NULL
-- display name. COUNT(*) OVER() carries the filtered total on every row so
-- the client pages without a second round-trip.
--
-- Reylo binds each parameter once: the WITH input row carries every filter
-- into the predicates below. Paging uses a ROW_NUMBER window rather than
-- OFFSET because PostgreSQL rejects variables in the OFFSET clause. Tokens
-- come from the normalized search key (letters/numbers/spaces only), so
-- they are LIKE-safe without extra escaping.
WITH input AS (
  SELECT :tokens::text[] AS tokens,
    :kind::nullable(text) AS kind, :parent_id::nullable(bigint) AS parent_id,
    :limit::int AS limit, :offset::int AS offset
),
filtered AS (
  SELECT p.id AS id, p.kind AS kind, p.iso3166 AS iso3166,
    p.display_latitude AS "displayLatitude", p.display_longitude AS "displayLongitude",
    p.display_note AS "displayNote", en.name AS "displayName",
    COUNT(*) OVER()::int AS total,
    ROW_NUMBER() OVER (ORDER BY p.id ASC) AS rn
  FROM feastjourney.places AS p
  CROSS JOIN input
  LEFT JOIN feastjourney.place_names AS en
    ON en.place_id = p.id AND en.language_tag = 'en' AND en.is_preferred
  WHERE (input.kind IS NULL OR p.kind = input.kind)
    AND (input.parent_id IS NULL OR EXISTS (
      SELECT 1 FROM feastjourney.place_parents AS pp
      WHERE pp.place_id = p.id AND pp.parent_place_id = input.parent_id
    ))
    AND EXISTS (
      SELECT 1 FROM feastjourney.place_names AS n
      WHERE n.place_id = p.id
        AND NOT EXISTS (
          SELECT 1 FROM unnest(input.tokens) AS token
          WHERE n.search_key NOT LIKE '%' || token || '%'
        )
    )
)
SELECT filtered.id AS id, filtered.kind AS kind, filtered.iso3166 AS iso3166,
  filtered."displayLatitude" AS "displayLatitude",
  filtered."displayLongitude" AS "displayLongitude",
  filtered."displayNote" AS "displayNote",
  filtered."displayName" AS "displayName",
  filtered.total AS total
FROM filtered
CROSS JOIN input
WHERE rn > input.offset AND rn <= input.offset + input.limit
ORDER BY id ASC
