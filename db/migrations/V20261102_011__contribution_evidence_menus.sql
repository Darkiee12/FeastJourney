-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261029_003__contribution_evidence_menus.sql (renumbered after V20261031_001, content unchanged).

-- Approved contribution facts are promoted per evidence page: each promoted
-- menu links the exact menu photograph that supports its items. Evidence
-- copies live under evidence/ keys (separate Garage objects outside
-- menu_scan_assets), so scan expiry cleanup never deletes reviewed evidence.
CREATE TABLE feastjourney.menu_scan_contribution_menus (
  contribution_id UUID NOT NULL REFERENCES feastjourney.menu_scan_contributions(id),
  menu_id UUID NOT NULL REFERENCES feastjourney.restaurant_menus(id),
  asset_id UUID NOT NULL REFERENCES feastjourney.menu_scan_assets(id),
  evidence_key TEXT NOT NULL CHECK (evidence_key ~ '^evidence/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, menu_id)
);
CREATE UNIQUE INDEX menu_contribution_primary_idx
  ON feastjourney.menu_scan_contribution_menus(contribution_id) WHERE is_primary;
CREATE INDEX menu_contribution_asset_idx
  ON feastjourney.menu_scan_contribution_menus(asset_id);
