-- TrailForge — persist forum-scan skips so moderators can revisit them.
--
-- When the AI forum scanner can't pull a downloadable GPX or snap to an OSM
-- track, it now refuses to write a fake straight-line trail. Previously the
-- skip was only reported as a string in the response body, so once the scan
-- result was gone moderators had no way to revisit those threads. This table
-- gives us a durable backlog they can work through.

CREATE TABLE IF NOT EXISTS ai_scan_skips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url      text NOT NULL,
  source_label    text,
  extracted_name  text,
  reason          text NOT NULL,
  -- 'pending' | 'resolved'
  status          text NOT NULL DEFAULT 'pending',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  seen_count      integer NOT NULL DEFAULT 1,
  resolved_at     timestamptz,
  resolved_by     text,
  resolved_note   text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_scan_skips_status_check'
  ) THEN
    ALTER TABLE ai_scan_skips
      ADD CONSTRAINT ai_scan_skips_status_check
      CHECK (status IN ('pending', 'resolved'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_scan_skips_source_url_idx
  ON ai_scan_skips (source_url);
CREATE INDEX IF NOT EXISTS ai_scan_skips_status_idx
  ON ai_scan_skips (status, last_seen_at DESC);

ALTER TABLE ai_scan_skips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_scan_skips_no_anon ON ai_scan_skips;
CREATE POLICY ai_scan_skips_no_anon ON ai_scan_skips
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
