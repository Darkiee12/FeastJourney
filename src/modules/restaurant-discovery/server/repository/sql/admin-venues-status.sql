UPDATE feastjourney.restaurant_venues SET status=:status::text,updated_at=now() WHERE id=ANY(:ids::uuid[]) RETURNING id;
