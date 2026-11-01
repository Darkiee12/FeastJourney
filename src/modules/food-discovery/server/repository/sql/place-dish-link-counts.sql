-- Linked-dish counts for one place over its whole descendant subtree
-- (the same subtree semantics discovery queries use), broken down by
-- association. Absent associations carry no row; the caller treats a
-- missing association as zero.
WITH RECURSIVE tree(id) AS (
  SELECT :place_id::bigint AS id
  UNION
  SELECT pp.place_id AS id
  FROM feastjourney.place_parents AS pp
  JOIN tree AS t ON t.id = pp.parent_place_id
)
SELECT dp.association AS association, COUNT(*)::int AS total
FROM feastjourney.dish_places AS dp
JOIN tree AS t ON t.id = dp.place_id
GROUP BY dp.association
