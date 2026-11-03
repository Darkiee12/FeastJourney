INSERT INTO feastjourney.user_profiles(user_id,preferred_currency) VALUES(:user::text,:currency::nullable(text))
ON CONFLICT(user_id) DO UPDATE SET preferred_currency=EXCLUDED.preferred_currency,updated_at=now()
RETURNING preferred_currency;
