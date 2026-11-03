INSERT INTO feastjourney.currency_refresh_leases(key,token,expires_at)
VALUES(:key::text,:token::uuid,now()+INTERVAL '15 seconds')
ON CONFLICT(key) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
WHERE feastjourney.currency_refresh_leases.expires_at<=now()
RETURNING token;
