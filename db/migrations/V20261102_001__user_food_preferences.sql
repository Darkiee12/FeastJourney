-- Member ingredient exclusions shared by the recommendation quiz and account
-- settings. Separate relation (not a profile column) so preference writes
-- can never clobber display_name/locale and vice versa. Referencing
-- user_profiles (whose PK is user_id) keeps one member-identity root; the
-- upsert ensures the profile row first with defaults, never overwriting it.
CREATE TABLE feastjourney.user_food_preferences (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES feastjourney.user_profiles (user_id) ON DELETE CASCADE,
  excluded_ingredients TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
