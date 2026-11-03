WITH saved AS (INSERT INTO feastjourney.currency_exchange_rates(base_currency,quote_currency,rate,effective_date,provider)
SELECT :base::text,:quote::text,:rate::numeric,:date::date,:provider::text
WHERE EXISTS(SELECT 1 FROM feastjourney.currency_refresh_leases WHERE key=:key::text AND token=:token::uuid AND expires_at>now())
ON CONFLICT(provider,base_currency,quote_currency,effective_date) DO UPDATE SET fetched_at=now()
WHERE feastjourney.currency_exchange_rates.rate=EXCLUDED.rate RETURNING rate)
SELECT rate FROM saved LIMIT 1;
