-- Referential integrity and one redundant index, found by the schema-drift gate
-- on its first strict run (2026-09-28). The schema declares these relations; no
-- migration has ever created the constraints, so the database has been accepting
-- orphan rows the whole time.
--
-- Everything here is idempotent. That is not a nicety: per AGENTS.md section 10 a
-- failed migration bricks the entire bot, because `npm start` runs `migrate deploy`
-- before Discord connects. The bot being down is a worse outcome than the drift.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each one is guarded by name in
-- a DO block - a bare ADD is a 42710 that would abort the deploy on any database
-- that already has it.

-- 1. artist_genres.artist_id -> artists.artist_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artist_genres_artist_id_fkey'
  ) THEN
    ALTER TABLE "artist_genres"
      ADD CONSTRAINT "artist_genres_artist_id_fkey"
      FOREIGN KEY ("artist_id") REFERENCES "artists"("artist_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. guild_autoposts.guild_id -> guilds.guild_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_autoposts_guild_id_fkey'
  ) THEN
    ALTER TABLE "guild_autoposts"
      ADD CONSTRAINT "guild_autoposts_guild_id_fkey"
      FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 3 + 4. user_crowns.guild_id -> guilds.guild_id, user_crowns.user_id -> users.user_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_crowns_guild_id_fkey'
  ) THEN
    ALTER TABLE "user_crowns"
      ADD CONSTRAINT "user_crowns_guild_id_fkey"
      FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_crowns_user_id_fkey'
  ) THEN
    ALTER TABLE "user_crowns"
      ADD CONSTRAINT "user_crowns_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. user_fm_settings.user_id -> users.user_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_fm_settings_user_id_fkey'
  ) THEN
    ALTER TABLE "user_fm_settings"
      ADD CONSTRAINT "user_fm_settings_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Reverse drift: a second index on exactly the primary key.
-- guild_users_pkey is already PRIMARY KEY (guild_id, user_id), and the schema
-- declares @@id([guildId, userId]) and nothing more. A migration created
-- guild_users_guild_id_user_id_idx over the same two columns, so every insert and
-- update of guild_users has been maintaining a duplicate index for nothing.
DROP INDEX IF EXISTS "guild_users_guild_id_user_id_idx";

-- The orphan rows these constraints might reject are NOT cleaned up here. A FK
-- cannot be added if existing rows violate it, so if this migration fails on a
-- production database with orphans, the correct response is to inspect and delete
-- them deliberately - not to weaken the constraint. That decision needs the real
-- data and is out of scope for a migration that must be safe to run unattended.
