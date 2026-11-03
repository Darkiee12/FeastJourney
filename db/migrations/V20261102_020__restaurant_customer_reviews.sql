-- FeastJourney first-party customer reviews for restaurant venues.
--
-- Customer reviews are distinct from the editorial price/serving-evidence
-- moderation queue (restaurant_price_observations / restaurant_serving_evidence
-- plus review.ts): guests read published reviews, members submit (always into
-- `pending`, never auto-published), authors edit or anonymize their own, and
-- moderation requires the `restaurant:review` grant. Public aggregates and
-- listings read `published` rows only; pending rows never affect averages.

CREATE TABLE feastjourney.restaurant_customer_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES feastjourney.restaurant_venues (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES "feastjourney"."user" ("id") ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL CHECK (char_length(body) <= 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  CHECK (published_at IS NULL OR status IN ('published', 'removed'))
);

-- One active (pending or decided-yet-visible) review per member per venue.
-- Rejected and removed rows stay for audit but never block a fresh submission.
CREATE UNIQUE INDEX restaurant_customer_reviews_active_author_idx
  ON feastjourney.restaurant_customer_reviews (venue_id, author_id)
  WHERE status IN ('pending', 'published');

-- Public listing order: newest published first per venue.
CREATE INDEX restaurant_customer_reviews_venue_status_idx
  ON feastjourney.restaurant_customer_reviews (venue_id, status, published_at DESC NULLS LAST, id DESC);
