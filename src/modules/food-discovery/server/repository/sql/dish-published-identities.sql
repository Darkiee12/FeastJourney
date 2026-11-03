SELECT id::text AS id,slug
FROM feastjourney.dishes
WHERE id=ANY(:ids::bigint[]) AND status='published'
ORDER BY id;
