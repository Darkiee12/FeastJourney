-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261028_101__restaurant_observation_integrity.sql (renumbered after V20261031_001, content unchanged).

-- Reviewed observations retain immutable provenance and structured receipt semantics.
CREATE FUNCTION feastjourney.restaurant_price_source_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category TEXT; receipt feastjourney.restaurant_receipt_lines;
BEGIN
  SELECT s.category INTO category FROM feastjourney.restaurant_sources s WHERE s.id=NEW.source_id;
  IF (category='receipt') IS DISTINCT FROM (NEW.price_kind='paid_unit') THEN
    RAISE EXCEPTION 'Receipt paid prices and listed prices require distinct sources' USING ERRCODE='23514';
  END IF;
  IF NEW.review_status='approved' AND NEW.price_kind='paid_unit' THEN
    SELECT * INTO receipt FROM feastjourney.restaurant_receipt_lines WHERE observation_id=NEW.id;
    IF NOT FOUND OR (receipt.explicit_unit_price IS NULL AND receipt.total_semantics<>'net_food_only')
      OR (receipt.explicit_unit_price IS NOT NULL AND receipt.explicit_unit_price<>NEW.amount)
      OR (receipt.total_semantics='net_food_only' AND NEW.amount*receipt.quantity<>receipt.line_total) THEN
      RAISE EXCEPTION 'Paid unit price requires unambiguous receipt evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_price_source_integrity BEFORE INSERT OR UPDATE ON feastjourney.restaurant_price_observations
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_price_source_integrity();

CREATE FUNCTION feastjourney.restaurant_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'eligible') IS DISTINCT FROM (to_jsonb(OLD)-'eligible') THEN
    RAISE EXCEPTION 'Source snapshots are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_source_immutable BEFORE UPDATE ON feastjourney.restaurant_sources
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_source_immutable();

CREATE FUNCTION feastjourney.restaurant_serving_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['review_status','reviewed_by','reviewed_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['review_status','reviewed_by','reviewed_at']) THEN
    RAISE EXCEPTION 'Serving evidence provenance is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_serving_immutable BEFORE UPDATE ON feastjourney.restaurant_serving_evidence
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_serving_immutable();

CREATE FUNCTION feastjourney.restaurant_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Receipt food lines are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER restaurant_receipt_immutable BEFORE UPDATE ON feastjourney.restaurant_receipt_lines
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_receipt_immutable();

ALTER TABLE feastjourney.restaurant_price_observations ADD CONSTRAINT restaurant_amount_supported_precision
  CHECK(scale(amount)<=18 AND amount<1e30::NUMERIC);
