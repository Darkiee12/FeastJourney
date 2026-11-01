-- Forward sequence for feat/restaurant-discovery-v2.
-- Merged from V20261030_102__reviewed_variant_text.sql + V20261030_103__observed_price_text.sql (independent single-statement ALTERs).

-- Preserve reviewed translations alongside original variant labels.
ALTER TABLE feastjourney.restaurant_menu_item_variants
 ADD COLUMN translation_language TEXT CHECK(translation_language IS NULL OR translation_language IN ('en','vi','ja','zh','ko','fr','es')),
 ADD COLUMN translated_label TEXT CHECK(length(translated_label) BETWEEN 1 AND 300),
 ADD CONSTRAINT restaurant_variant_translation_language CHECK(translated_label IS NULL OR translation_language IS NOT NULL);

-- Preserve printed tokens separately from authoritative exact NUMERIC interpretations.
ALTER TABLE feastjourney.restaurant_price_observations ADD COLUMN raw_text TEXT CHECK(length(raw_text)<=200);
