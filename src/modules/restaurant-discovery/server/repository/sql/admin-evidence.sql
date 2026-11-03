INSERT INTO feastjourney.restaurant_serving_evidence(venue_id,menu_item_id,dish_id,source_id,match_kind,observed_at,review_after)
VALUES(:venue::uuid,:item::uuid,:dish::bigint,:source::uuid,:match::text,:observed::timestamptz,:until::timestamptz) RETURNING id;
