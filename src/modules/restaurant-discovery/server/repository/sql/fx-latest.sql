SELECT base_currency AS base,quote_currency AS quote,rate,effective_date AS "effectiveDate",provider,fetched_at
FROM feastjourney.currency_exchange_rates
WHERE provider=:provider::text AND base_currency=:base::text AND quote_currency=:quote::text
ORDER BY effective_date DESC LIMIT 1;
