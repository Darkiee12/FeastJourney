SELECT c.code,catalog.fetched_at
FROM feastjourney.currency_provider_catalog catalog
JOIN feastjourney.currency_codes c ON c.code=ANY(catalog.codes)
WHERE catalog.provider=:provider::text ORDER BY c.code;
