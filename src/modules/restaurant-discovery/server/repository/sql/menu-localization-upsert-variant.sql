-- Guarded variant refresh: variant-label twin of the item upsert, with
-- the same never-overwrite-curator and no-churn-on-cache-hit guards.
INSERT INTO feastjourney.restaurant_menu_localizations
 (venue_id,item_id,variant_id,target,source_hash,display_name,description,explanation,
  status,provider,model,prompt_version,schema_version)
VALUES (:venue::uuid,NULL,:variant::uuid,:target::text,:hash::text,:name::text,
 :description::nullable(text),:explanation::nullable(text),'machine',:provider::text,:model::text,:prompt::text,:schema::integer)
ON CONFLICT(variant_id,target) WHERE item_id IS NULL DO UPDATE SET
 source_hash=EXCLUDED.source_hash,display_name=EXCLUDED.display_name,
 description=EXCLUDED.description,explanation=EXCLUDED.explanation,
 provider=EXCLUDED.provider,model=EXCLUDED.model,
 prompt_version=EXCLUDED.prompt_version,schema_version=EXCLUDED.schema_version,
 created_at=now()
WHERE restaurant_menu_localizations.status='machine'
 AND restaurant_menu_localizations.source_hash<>EXCLUDED.source_hash;
