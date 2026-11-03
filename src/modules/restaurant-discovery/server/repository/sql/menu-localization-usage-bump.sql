-- Monthly spend ledger: bump the call/char counters for one provider
-- model and return the new totals so the application can refuse generation
-- past the documented caps before the next provider call.
INSERT INTO feastjourney.restaurant_menu_localization_usage AS u
 (provider,model,period,calls,chars)
VALUES (:provider::text,:model::text,:period::text,1,:chars::integer)
ON CONFLICT(provider,model,period) DO UPDATE SET
 calls=u.calls+1,chars=u.chars+EXCLUDED.chars,updated_at=now()
RETURNING u.calls AS calls,u.chars AS chars;
