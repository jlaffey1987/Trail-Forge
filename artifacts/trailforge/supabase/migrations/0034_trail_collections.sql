-- TrailForge — Featured Trail Collections.
--
-- Curated collections of trail sections that riders can browse and load as a
-- map layer. Collections may be official (TET, TRF) or community-created.

CREATE TABLE IF NOT EXISTS trail_collections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  description      text,
  cover_image_url  text,
  region           text,
  difficulty_min   integer,
  difficulty_max   integer,
  total_distance_km double precision,
  is_featured      boolean DEFAULT false,
  is_official      boolean DEFAULT false,
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trail_collection_sections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES trail_collections(id) ON DELETE CASCADE,
  trail_id      uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  order_index   integer NOT NULL DEFAULT 0,
  is_optional   boolean DEFAULT false,
  UNIQUE (collection_id, trail_id)
);

CREATE INDEX IF NOT EXISTS tcs_collection_idx ON trail_collection_sections(collection_id);
CREATE INDEX IF NOT EXISTS tcs_trail_idx ON trail_collection_sections(trail_id);

-- RLS: everyone can read featured collections; only admins can write.
ALTER TABLE trail_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE trail_collection_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_collections"
  ON trail_collections FOR SELECT USING (true);

CREATE POLICY "public_read_collection_sections"
  ON trail_collection_sections FOR SELECT USING (true);

-- ── Seed featured collections ────────────────────────────────────────────────

INSERT INTO trail_collections (name, description, region, is_featured, is_official) VALUES
  ('Great Northern Trail',       'The full TET-UK Great Northern Trail from the Scottish border to the Yorkshire Dales', 'England North',      true, true),
  ('Cymru Trail',                'The Welsh section of the Trans Euro Trail across Wales', 'Wales',             true, true),
  ('Borderlands',                'Cross-border trails linking England and Scotland through the Cheviots', 'Scotland/England',  true, true),
  ('Yorkshire Dales Green Lanes','Classic green lane riding through the Yorkshire Dales national park', 'England North',      true, false),
  ('Peak District Trails',       'Technical byway and green lane network across the Peak District', 'England Midlands',   true, false),
  ('Dartmoor Green Lanes',       'Ancient trackways and open moorland routes across Dartmoor', 'England South',      true, false),
  ('Scottish Highlands',         'Remote highland trails and forest tracks through the Scottish Highlands', 'Scotland',          true, false),
  ('Snowdonia Trails',           'Mountain and forest trails through the Snowdonia national park', 'Wales',             true, false)
ON CONFLICT DO NOTHING;
