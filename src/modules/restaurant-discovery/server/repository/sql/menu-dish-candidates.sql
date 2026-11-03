SELECT DISTINCT ev.dish_id::text AS dish_id
FROM feastjourney.restaurant_eligible_evidence ev
WHERE ev.venue_id=:id::uuid;
