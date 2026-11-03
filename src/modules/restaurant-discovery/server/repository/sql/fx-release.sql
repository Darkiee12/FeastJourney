UPDATE feastjourney.currency_refresh_leases SET expires_at=now()+INTERVAL '5 minutes'
WHERE key=:key::text AND token=:token::uuid;
