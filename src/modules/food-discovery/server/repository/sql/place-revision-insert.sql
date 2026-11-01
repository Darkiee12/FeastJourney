INSERT INTO feastjourney.place_revisions (place_id, actor, operation, summary)
VALUES (:place_id::nullable(bigint), :actor::text, :operation::text, :summary::text)
