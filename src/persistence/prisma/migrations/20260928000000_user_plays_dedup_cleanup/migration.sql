-- Task 1.2 step 2a: remove duplicate plays, so a unique index can be added.
--
-- WHY. playRepository.batchInsertPlays passes skipDuplicates: true to Prisma,
-- but the only unique key on user_plays is the autoincrement user_play_id, so
-- that flag is a no-op and the guarantee it appears to provide is not real.
-- Dedup lived entirely in application code (an identity set inside
-- updateService.performDeltaSync), which the chunk-insert retry bypasses when a
-- commit succeeds and its ack is lost.
--
-- MEASURED FIRST. scripts/count-duplicate-plays.ts against production on
-- 2026-09-28: 303,424 plays, 0 duplicate keys, 0 extra rows, 0 users
-- affected. So this DELETE is a no-op today. It is kept in the migration rather
-- than dropped so that a database copy that DID drift can be repaired by the
-- same file, and so the index in 2b cannot fail on existing violations.
--
-- The identity deliberately matches performDeltaSync's: user, played-at,
-- artist, track, source, case-insensitively, with a null track treated as
-- empty. The earliest row is kept so the retained user_play_id is stable and
-- the oldest record is the survivor.
--
-- This is a separate file from the index on purpose. Prisma only runs
-- CREATE INDEX CONCURRENTLY outside a transaction when the migration has
-- statement arity 1; with two statements it wraps them and the CONCURRENTLY
-- fails with "cannot run inside a transaction block". See 2b.

DELETE FROM "user_plays" p
USING "user_plays" q
WHERE p."user_id" = q."user_id"
  AND p."time_played" = q."time_played"
  AND lower(p."artist_name") = lower(q."artist_name")
  AND coalesce(lower(p."track_name"), '') = coalesce(lower(q."track_name"), '')
  AND coalesce(p."play_source"::text, '') = coalesce(q."play_source"::text, '')
  AND p."user_play_id" > q."user_play_id";
