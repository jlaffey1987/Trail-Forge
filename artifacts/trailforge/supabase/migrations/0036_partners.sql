-- TrailForge — Club & Creator Partners.
--
-- Extends the users table with account_type, partner verification, and
-- creator-specific fields. Club partners can bulk-upload GPX files and their
-- members receive free premium access.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_type text DEFAULT 'rider'
    CHECK (account_type IN ('rider', 'club_partner', 'content_creator', 'moderator', 'admin')),
  ADD COLUMN IF NOT EXISTS partner_name          text,
  ADD COLUMN IF NOT EXISTS partner_verified      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS creator_channel_url   text,
  ADD COLUMN IF NOT EXISTS creator_follower_count integer;

-- Index for quickly listing all verified club partners.
CREATE INDEX IF NOT EXISTS users_account_type_idx ON users(account_type);
CREATE INDEX IF NOT EXISTS users_partner_verified_idx ON users(partner_verified) WHERE partner_verified = true;
