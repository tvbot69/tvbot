-- Phase 3.3: durable per-guild music prefs (247/volume/loop/autoplay/filters)
-- and bot-scrobbling opt-ins. Previously process memory only — every deploy
-- wiped them. All statements idempotent for safe re-application.

CREATE TABLE IF NOT EXISTS "guild_music_settings" (
  "guild_id" BIGINT NOT NULL,
  "stay_247" BOOLEAN NOT NULL DEFAULT false,
  "volume" INTEGER NOT NULL DEFAULT 100,
  "loop_mode" VARCHAR(10) NOT NULL DEFAULT 'off',
  "autoplay" BOOLEAN NOT NULL DEFAULT false,
  "filters" TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT "guild_music_settings_pkey" PRIMARY KEY ("guild_id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_music_settings_guild_id_fkey'
  ) THEN
    ALTER TABLE "guild_music_settings"
      ADD CONSTRAINT "guild_music_settings_guild_id_fkey"
      FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "bot_scrobble_opt_ins" (
  "discord_user_id" BIGINT NOT NULL,
  "created" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bot_scrobble_opt_ins_pkey" PRIMARY KEY ("discord_user_id")
);
