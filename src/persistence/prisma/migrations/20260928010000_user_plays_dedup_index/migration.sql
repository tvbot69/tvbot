-- Task 1.2 step 2b: make that dedup guarantee real at the database level.
--
-- READ THIS BEFORE EDITING. This file must contain EXACTLY ONE STATEMENT.
--
-- Prisma's docs say it does not wrap Postgres migrations in a transaction, and
-- that is true only sometimes: it decides by statement arity. A migration with
-- a single non-transactional statement runs outside a transaction, so
-- CREATE INDEX CONCURRENTLY works. Add a second statement to this file and
-- Prisma wraps BOTH in a transaction, and the build fails with
-- "CREATE INDEX CONCURRENTLY cannot run inside a transaction block" (25001).
-- The cleanup DELETE therefore lives in the previous migration file.
--
-- That is why the statement count is load-bearing here rather than a style
-- preference, and it is worth remembering when the next index is added.
--
-- CONCURRENTLY so a 300k-row build does not block writes to user_plays for
-- its duration. Reads are unaffected either way.
--
-- NULLS NOT DISTINCT (Postgres 15+; this host is 18.6) is essential rather than
-- decorative: without it Postgres treats NULLs as distinct, so a null
-- track_name or a null play_source would slip past the constraint entirely and
-- the guarantee would be partial in exactly the cases most likely to be real.
--
-- A functional index cannot be expressed in schema.prisma, so it lives here
-- only and this file is the source of truth. Do not run `prisma migrate dev`
-- expecting parity for it.
--
-- The identity is deliberately LOOSE so it rejects a genuine second play rather
-- than admitting one. The trade-off, stated so it is a decision: two real
-- scrobbles of the same track in the same second from the same source are now
-- treated as one. That is the intended reading, and matching the
-- application-level dedup is what makes the index correct rather than stricter.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "user_plays_identity_uniq"
  ON "user_plays" (
    "user_id",
    "time_played",
    lower("artist_name"),
    coalesce(lower("track_name"), ''),
    coalesce("play_source"::text, '')
  ) NULLS NOT DISTINCT;
