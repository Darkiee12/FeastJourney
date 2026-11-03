WITH saved AS (INSERT INTO feastjourney.currency_provider_catalog(provider,codes)
SELECT :provider::text,:codes::text[]
WHERE EXISTS(SELECT 1 FROM feastjourney.currency_refresh_leases WHERE key=:key::text AND token=:token::uuid AND expires_at>now())
ON CONFLICT(provider) DO UPDATE SET codes=EXCLUDED.codes,fetched_at=now()
RETURNING provider)
SELECT provider FROM saved LIMIT 1;
