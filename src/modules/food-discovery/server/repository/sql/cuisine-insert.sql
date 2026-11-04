INSERT INTO feastjourney.cuisines (slug)
VALUES (:slug::text)
RETURNING id, slug, created_at, updated_at;
