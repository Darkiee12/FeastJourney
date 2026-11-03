-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261028_106__unknown_receipt_adjustments.sql (renumbered after V20261031_001, content unchanged).

-- Unknown adjustments are not zero. A known net food-line total can still
-- establish a paid unit price without inventing its discount/fee breakdown.
ALTER TABLE feastjourney.restaurant_receipt_lines
 ALTER COLUMN discount DROP NOT NULL,
 ALTER COLUMN taxes_fees DROP NOT NULL;
