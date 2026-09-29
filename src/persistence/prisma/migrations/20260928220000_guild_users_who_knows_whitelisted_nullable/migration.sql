-- guild_users.who_knows_whitelisted was BOOLEAN NOT NULL DEFAULT false, which made
-- four user-facing who-knows queries return nothing for every ordinary member.
--
-- The bug: those queries filter on
--     (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
-- which admits "whitelisted, or not yet decided". With NOT NULL DEFAULT false the
-- column can only ever be false, so the predicate is false for EVERY row that can
-- exist, and the four statements succeed and return an empty set. No error, no log
-- line, no catch involved - total failure that renders as a correct-looking empty
-- leaderboard. In fmbot the column is nullable and NULL for an ordinary member,
-- which is exactly what the `OR ... IS NULL` half of the predicate expects. The
-- schema drift inverted the meaning of the query.
--
-- The evidence that this is a defect and not a filter: GuildRankingService omits
-- the clause in all four of its guild charts and they work, and the two sibling
-- methods in each of genreService/countryService also omit it and work. Six
-- statements with the clause are dead; six without it are not.
--
-- Fix is fmbot parity: nullable, no default, so an undecided member is NULL and
-- passes, and an explicit false still excludes. Nothing in this codebase ever
-- WRITES this column (the only writer of a who_knows_whitelisted column is
-- channelRepository.ts:38, which writes the `channels` table, a different one), so
-- today this changes no row - it restores the semantics the queries assume.
--
-- Idempotent, and that is the load-bearing property: per AGENTS.md section 10 a
-- failed migration bricks the whole bot, because `npm start` runs
-- `migrate deploy` before Discord connects. A bot that is down is worse than four
-- empty leaderboards. DROP NOT NULL and DROP DEFAULT are both safe to re-run, and
-- both are no-ops on a database already in the target shape.
--
-- One deliberate asymmetry, stated rather than hidden: existing rows currently hold
-- false, and that value is left alone. A false row is an explicit "excluded", which
-- is the safe direction - the fix un-excludes nobody who was deliberately excluded.
-- Rows created after this migration are NULL and admitted. Converting the existing
-- falses to NULL would un-exclude every member of every guild that ever had a row
-- written before the column became vestigial, and that is a product decision about
-- live user data, not something a migration should do unattended.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guild_users'
      AND column_name = 'who_knows_whitelisted'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "guild_users" ALTER COLUMN "who_knows_whitelisted" DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guild_users'
      AND column_name = 'who_knows_whitelisted'
      AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE "guild_users" ALTER COLUMN "who_knows_whitelisted" DROP DEFAULT;
  END IF;
END $$;
