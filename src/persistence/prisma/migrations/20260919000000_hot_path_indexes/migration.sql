-- Phase 2.4 hot-path indexes (wk/crowns/rankings/at/playcount).
-- NOTE: functional (UPPER(...)) indexes cannot be expressed in schema.prisma,
-- so they live here only. Do NOT run `prisma migrate dev` expecting parity for
-- them; this file is the source of truth. All statements are IF NOT EXISTS
-- for safe re-application. The users(privacy_level) index repairs drift from
-- the db-push era (it exists live but in no earlier migration).

-- Repair drift: privacyLevel index (schema @@index exists, no migration had it).
CREATE INDEX IF NOT EXISTS "users_privacy_level_idx" ON "users"("privacy_level");

-- Guild member scans: every leaderboard joins guild_users by guild first.
CREATE INDEX IF NOT EXISTS "guild_users_guild_id_user_id_idx" ON "guild_users"("guild_id", "user_id");

-- Case-insensitive artist lookups (UPPER(name) predicates can't use btree name indexes).
CREATE INDEX IF NOT EXISTS "user_artists_upper_name_idx" ON "user_artists"(UPPER("name"));

-- The user_crowns index used to live here and FAILED on a fresh database with
-- 42P01 "relation user_crowns does not exist". user_crowns was never created by
-- any migration - it dates from the `prisma db push` era - so it did not exist
-- at this point in the sequence. It moved to 20260928120000, which creates the
-- table and then indexes it. An index cannot be created before its table.
--
-- Production is unaffected: this migration was already applied there, so the
-- index it used to create is still in place. Fresh databases now get it from
-- the later migration. IF NOT EXISTS everywhere makes that a no-op either way.

-- Per-user case-insensitive play scans (at, playcount, dd/ll, streaks).
CREATE INDEX IF NOT EXISTS "user_plays_user_upper_artist_idx" ON "user_plays"("user_id", UPPER("artist_name"));
