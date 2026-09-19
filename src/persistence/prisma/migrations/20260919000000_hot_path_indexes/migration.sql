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

-- Crown lookups by guild + case-insensitive artist.
CREATE INDEX IF NOT EXISTS "user_crowns_guild_upper_artist_idx" ON "user_crowns"("guild_id", UPPER("artist_name"));

-- Per-user case-insensitive play scans (at, playcount, dd/ll, streaks).
CREATE INDEX IF NOT EXISTS "user_plays_user_upper_artist_idx" ON "user_plays"("user_id", UPPER("artist_name"));
