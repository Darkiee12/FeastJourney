SELECT user_id, excluded_ingredients
FROM feastjourney.user_food_preferences
WHERE user_id = :user_id;
