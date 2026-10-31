WITH input AS(SELECT :q::text AS q)
SELECT b.id,b.name,count(v.id)::int AS venue_count,count(*) OVER()::int AS total
FROM feastjourney.restaurant_businesses b
LEFT JOIN feastjourney.restaurant_venues v ON v.business_id=b.id
CROSS JOIN input i
WHERE (i.q='' OR lower(b.name) LIKE i.q)
GROUP BY b.id,b.name ORDER BY b.name ASC,b.id LIMIT :limit::int OFFSET :offset::int;
