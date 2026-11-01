WITH input AS (
  SELECT :user_id::text AS user_id,
    :excluded_ingredients::text[] AS excluded_ingredients
),
ensured_profile AS (
  INSERT INTO feastjourney.user_profiles (user_id)
  SELECT user_id
  FROM input
  ON CONFLICT (user_id) DO NOTHING
  RETURNING user_id
)
INSERT INTO feastjourney.user_food_preferences (user_id, excluded_ingredients)
VALUES (
  (SELECT user_id FROM input),
  (SELECT excluded_ingredients FROM input)
)
ON CONFLICT (user_id) DO UPDATE
  SET excluded_ingredients = EXCLUDED.excluded_ingredients,
    updated_at = now()
RETURNING user_id, excluded_ingredients;
