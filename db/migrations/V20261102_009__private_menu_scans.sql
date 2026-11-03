-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261029_001__private_menu_scans.sql (renumbered after V20261031_001, content unchanged).

-- Private drafts extend restaurant discovery. Published menus remain relational.
CREATE TABLE feastjourney.menu_scan_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id TEXT REFERENCES feastjourney."user"(id),
 guest_hash TEXT CHECK (guest_hash ~ '^[a-f0-9]{64}$'),
 venue_id UUID REFERENCES feastjourney.restaurant_venues(id),
 target_language TEXT NOT NULL CHECK (target_language IN ('en','vi','ja','zh','ko','fr','es')),
 status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','processing','complete','failed','deleting','deleted')),
 current_revision INTEGER,
 lease_token UUID,
 lease_expires_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 CHECK ((owner_user_id IS NULL) <> (guest_hash IS NULL)),
 CHECK (expires_at > created_at),
 CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX menu_scan_expiration_idx ON feastjourney.menu_scan_sessions(expires_at) WHERE status <> 'deleted';
CREATE TABLE feastjourney.menu_scan_assets (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id UUID NOT NULL REFERENCES feastjourney.menu_scan_sessions(id),
 object_key TEXT NOT NULL UNIQUE,
 page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 6),
 media_type TEXT CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
 byte_length INTEGER CHECK (byte_length BETWEEN 1 AND 8388608),
 width INTEGER CHECK (width BETWEEN 1 AND 12000),
 height INTEGER CHECK (height BETWEEN 1 AND 12000),
 checksum TEXT CHECK (checksum ~ '^[a-f0-9]{64}$'),
 status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','deleting','deleted')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ,
 delete_attempts INTEGER NOT NULL DEFAULT 0,
 CHECK (width::bigint * height <= 20000000),
 CHECK (status <> 'ready' OR (media_type IS NOT NULL AND byte_length IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND checksum IS NOT NULL)),
 UNIQUE(id,session_id)
);
CREATE UNIQUE INDEX menu_scan_page_idx ON feastjourney.menu_scan_assets(session_id,page_number) WHERE status IN ('uploading','ready');
CREATE INDEX menu_scan_checksum_idx ON feastjourney.menu_scan_assets(checksum) WHERE status='ready';
CREATE TABLE feastjourney.menu_scan_revisions (
 session_id UUID NOT NULL REFERENCES feastjourney.menu_scan_sessions(id),
 revision INTEGER NOT NULL CHECK (revision > 0),
 document JSONB NOT NULL CHECK (jsonb_typeof(document)='object' AND document->>'schemaVersion'='1' AND octet_length(document::text) <= 1048576),
 origin TEXT NOT NULL CHECK (origin IN ('model','customer')),
 model TEXT,
 actor_user_id TEXT REFERENCES feastjourney."user"(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(session_id,revision),
 CHECK ((origin='model') = (model IS NOT NULL))
);
ALTER TABLE feastjourney.menu_scan_sessions ADD CONSTRAINT menu_scan_current_revision_fk
 FOREIGN KEY(id,current_revision) REFERENCES feastjourney.menu_scan_revisions(session_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION feastjourney.menu_scan_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Menu scan revisions are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER menu_scan_revision_immutable BEFORE UPDATE ON feastjourney.menu_scan_revisions
 FOR EACH ROW EXECUTE FUNCTION feastjourney.menu_scan_revision_immutable();
CREATE TABLE feastjourney.menu_scan_contributions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id UUID NOT NULL,
 revision INTEGER NOT NULL,
 consent_terms TEXT NOT NULL CHECK (consent_terms='menu-facts-v1'),
 consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 requested_venue_id UUID REFERENCES feastjourney.restaurant_venues(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
 reviewed_by TEXT REFERENCES feastjourney."user"(id),
 reviewed_at TIMESTAMPTZ,
 review_notes TEXT,
 promoted_menu_id UUID REFERENCES feastjourney.restaurant_menus(id),
 retention_until TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(session_id,revision) REFERENCES feastjourney.menu_scan_revisions(session_id,revision),
 UNIQUE(session_id,revision),
 CHECK (status='pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_notes IS NOT NULL)),
 CHECK (status<>'approved' OR promoted_menu_id IS NOT NULL)
);
CREATE INDEX menu_contribution_queue_idx ON feastjourney.menu_scan_contributions(consented_at) WHERE status='pending';
