-- Exact search-key lookup for duplicate-identity checks: every place with
-- a name whose search key equals one of the candidates, with the kind and
-- matched name inline so the caller compares parent sets without N+1 reads.
SELECT p.id AS id, p.kind AS kind, p.iso3166 AS iso3166,
  n.language_tag AS language_tag, n.name AS name,
  n.is_preferred AS is_preferred, n.search_key AS search_key
FROM feastjourney.places AS p
JOIN feastjourney.place_names AS n ON n.place_id = p.id
WHERE n.search_key = ANY(:keys::text[])
ORDER BY p.id ASC
