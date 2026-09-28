-- Repairs a gap in the migration history.
--
-- Four tables exist in production but in NO migration file: user_fm_settings,
-- artist_genres, user_crowns and guild_autoposts. They date from the
-- `prisma db push` era, so they were never captured as migrations.
--
-- Why that mattered: a database built purely from these migrations was missing
-- four tables, and 20260919000000_hot_path_indexes - which indexes user_crowns -
-- failed with 42P01 "relation user_crowns does not exist". The bot ran fine in
-- production and would have been broken on any rebuild, restore or new
-- environment. The history could not reproduce the schema it described.
--
-- The DDL below is NOT hand-written. It is extracted from Prisma's own output:
--   prisma migrate diff --from-empty --to-schema-datamodel schema.prisma
-- Before this was written, the live database was diffed against the schema and
-- the diff was EMPTY - which is the evidence that production already has exactly
-- this structure, so applying this changes nothing there.
--
-- Every statement is IF NOT EXISTS on purpose. This migration has to be a no-op
-- on production, where the tables exist, and create them on a fresh database.
-- That asymmetry is the point; a plain CREATE TABLE would fail on deploy.
--
-- Indexes for these tables that already exist in earlier migrations are left
-- alone on purpose - the index a table needs before it is created cannot live in
-- the migration that creates it.

CREATE TABLE IF NOT EXISTS "user_fm_settings" (
    "user_id" INTEGER NOT NULL,
    "embed_type" INTEGER NOT NULL DEFAULT 0,
    "footer_options" BIGINT NOT NULL DEFAULT 16,
    "buttons" BIGINT NOT NULL DEFAULT 0,
    "small_text_type" INTEGER,
    "private_button_response" BOOLEAN,
    "modified" TIMESTAMPTZ(6),

    CONSTRAINT "user_fm_settings_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE IF NOT EXISTS "artist_genres" (
    "id" SERIAL NOT NULL,
    "artist_id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "artist_genres_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "user_crowns" (
    "crown_id" SERIAL NOT NULL,
    "guild_id" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "artist_name" VARCHAR(255) NOT NULL,
    "current_playcount" INTEGER NOT NULL,
    "start_playcount" INTEGER NOT NULL,
    "created" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modified" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "seeded_crown" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_crowns_pkey" PRIMARY KEY ("crown_id")
);

CREATE TABLE IF NOT EXISTS "guild_autoposts" (
    "id" SERIAL NOT NULL,
    "guild_id" BIGINT NOT NULL,
    "channel_id" BIGINT NOT NULL,
    "content_type" VARCHAR(50) NOT NULL,
    "schedule" VARCHAR(20) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_posted" TIMESTAMPTZ(6),
    "created" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_autoposts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "artist_genres_artist_id_idx" ON "artist_genres"("artist_id");

CREATE UNIQUE INDEX IF NOT EXISTS "artist_genres_artist_id_name_key" ON "artist_genres"("artist_id", "name");

CREATE INDEX IF NOT EXISTS "user_crowns_guild_id_artist_name_idx" ON "user_crowns"("guild_id", "artist_name");

CREATE INDEX IF NOT EXISTS "user_crowns_guild_id_active_idx" ON "user_crowns"("guild_id", "active");

CREATE INDEX IF NOT EXISTS "user_crowns_user_id_idx" ON "user_crowns"("user_id");

CREATE INDEX IF NOT EXISTS "guild_autoposts_guild_id_idx" ON "guild_autoposts"("guild_id");
-- Crown lookups by guild + case-insensitive artist. This used to live in
-- 20260919000000_hot_path_indexes and failed there on a fresh database with
-- 42P01, because user_crowns did not exist yet at that point in the sequence.
-- It belongs immediately after the table it indexes.
CREATE INDEX IF NOT EXISTS "user_crowns_guild_upper_artist_idx" ON "user_crowns"("guild_id", UPPER("artist_name"));