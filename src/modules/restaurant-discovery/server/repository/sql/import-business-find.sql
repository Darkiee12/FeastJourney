-- Business reuse by exact normalized name: linking an applied venue to an
-- existing business row never overwrites curator data (businesses carry only
-- a name). No fuzzy matching here; near-misses create their own business so
-- a curator can merge them deliberately later.
SELECT id
FROM feastjourney.restaurant_businesses
WHERE lower(btrim(name)) = lower(btrim(:name::text))
ORDER BY id ASC
LIMIT 1
