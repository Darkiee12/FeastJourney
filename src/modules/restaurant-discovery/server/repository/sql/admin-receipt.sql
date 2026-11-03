INSERT INTO feastjourney.restaurant_receipt_lines(observation_id,quantity,explicit_unit_price,line_total,discount,taxes_fees,total_semantics)
VALUES(:observation::uuid,:quantity::numeric,:unit::nullable(numeric),:total::numeric,:discount::nullable(numeric),:fees::nullable(numeric),:semantics::text);
