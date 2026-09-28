-- Task 1.2 step 2b: make that dedup guarantee real at the database level.
--
-- WHY THE FIRST VERSION OF THIS FILE FAILED
-- It cast the play_source enum to text:
--
--   coalesce("play_source"::text, '')
--
-- and Postgres refused with SqlState 42P17, "functions in index expression must
-- be marked IMMUTABLE". The cause was measured, not guessed:
--
--   select provolatile from pg_proc where proname = 'enum_out';   ->  's'  (STABLE)
--
-- An enum -> text conversion goes through enum_out, which is STABLE, so it is
-- rejected in an index expression. It does NOT appear in pg_cast at all, because
-- I/O conversions are not catalogued as casts - which is why a pg_cast probe
-- returns nothing and proves nothing. Do not go looking in pg_cast.
--
-- FIX: index the enum column directly. A btree index compares the enum by its
-- own type, which is exactly the equality we want, and it avoids a lossy text
-- round-trip as a bonus.
--
-- play_source is NULLABLE, so the NULL case is handled by NULLS NOT DISTINCT
-- below rather than by a coalesce. That is also why the cast could not simply be
-- deleted without thought: a bare nullable column would let every NULL
-- play_source pass as distinct, and the guarantee would be partial in exactly
-- the cases most likely to be real.
--
-- lower() and coalesce() are both fine here - lower is IMMUTABLE and coalesce is
-- a SQL construct, not a function call, so it has no volatility to violate.
--
-- READ THIS BEFORE EDITING. This file must contain EXACTLY ONE STATEMENT.
-- Prisma decides transaction-wrapping by statement arity: one statement runs
-- outside a transaction so CREATE INDEX CONCURRENTLY works, two statements get
-- wrapped. Keep the DELETE in its own migration file. (The original comment here
-- blamed the single-statement rule for a 25001 error; the real error was 42P17,
-- so the rule is still worth keeping but it was never the cause.)
--
-- CONCURRENTLY so a 300k-row build does not block writes to user_plays. Reads
-- are unaffected either way. Measured 2026-09-28: 303,424 rows, 0 duplicate
-- groups, so this builds without conflict.
--
-- The identity is deliberately LOOSE so it rejects a genuine second play rather
-- than admitting one: two real scrobbles of the same track in the same second
-- from the same source are treated as one. That is the intended reading, and
-- matching the application-level dedup is what makes the index correct rather
-- than stricter.
--
-- A functional index cannot be expressed in schema.prisma, so it lives here
-- only and this file is the source of truth. Do not run `prisma migrate dev`
-- expecting parity for it.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "user_plays_identity_uniq"
  ON "user_plays" (
    "user_id",
    "time_played",
    lower("artist_name"),
    coalesce(lower("track_name"), ''),
    "play_source"
  ) NULLS NOT DISTINCT;
