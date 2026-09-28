/**
 * Measure duplicate plays. READ-ONLY — this script deletes nothing.
 *
 * WHY THIS EXISTS. `playRepository.batchInsertPlays` passes
 * `skipDuplicates: true` to Prisma, but the only unique key on `user_plays` is
 * the autoincrement `user_play_id`. There is nothing for that flag to skip, so
 * the guarantee it appears to provide is not real. Dedup currently lives in
 * application code (an identity set in `updateService.performDeltaSync`) and the
 * nightly ReconcileService heals the drift afterwards.
 *
 * Two routes produce a duplicate:
 *   1. a concurrent delta sync, because the dedup guard was check-then-set
 *      (fixed in 5d7640d, but existing rows predate that)
 *   2. a chunk that committed and whose ack was lost, so the retry re-sent rows
 *
 * The identity used here matches what `performDeltaSync` treats as the same
 * play: user, played-at timestamp, artist name, track name, source. It is
 * deliberately LOOSE — case-insensitive, null track name as empty — so it
 * over-reports rather than missing rows. A count of 0 is therefore meaningful;
 * anything above it is a floor, not an exact figure.
 *
 * Run:  npm run db:count-duplicates
 * Requires DATABASE_URL. Point it at a COPY of production, not production.
 */

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * The duplicate identity as a SQL fragment, in one place so the counting
 * queries and the later cleanup migration can share it verbatim.
 *
 * It has to go in via `Prisma.raw`. Interpolating a plain string into a
 * `$queryRaw` tagged template binds it as a PARAMETER, so the fragment arrives
 * as a bind value and the query dies with a syntax error near "AS". The rest of
 * each query stays fully parameterised; only this known-constant fragment is
 * inlined.
 */
const IDENTITY = [
  '(',
  "user_id::text || '|' ||",
  "time_played::text || '|' ||",
  'lower(artist_name) ||',
  "'|' ||",
  "coalesce(lower(track_name), '') ||",
  "'|' ||",
  "coalesce(play_source::text, '')",
  ')',
].join(' ');

const ident = () => Prisma.raw(IDENTITY);

const main = async (): Promise<void> => {
  try {
    const total = await prisma.userPlay.count();
    console.log(`total plays: ${total}\n`);

    const summary = await prisma.$queryRaw<Array<{ dup_keys: bigint; extra_rows: bigint }>>`
      SELECT
        count(*)::bigint                          AS dup_keys,
        coalesce(sum(d.c - 1), 0)::bigint         AS extra_rows
      FROM (
        SELECT ${ident()} AS ident, count(*) AS c
        FROM user_plays
        GROUP BY 1
        HAVING count(*) > 1
      ) d
    `;

    const dupKeys = summary[0]?.dup_keys ?? 0n;
    const extraRows = summary[0]?.extra_rows ?? 0n;
    const pct = total > 0 ? (Number(extraRows) / total) * 100 : 0;

    console.log('=== duplicate summary (user + time + artist + track + source) ===');
    console.log(`  distinct duplicate keys : ${dupKeys}`);
    console.log(`  extra rows to remove    : ${extraRows}`);
    console.log(`  share of the table      : ${pct.toFixed(4)}%`);

    if (extraRows === 0n) {
      console.log('\n  clean: no duplicates, so a unique index needs no data fix first.');
      console.log('\nThis script changed nothing. See PLAN_B_PLUS_TO_A.md task 1.2 step 2 for');
      console.log('the cleanup migration and the unique index.');
      return;
    }

    // Postgres will not let you reference user_id in an aggregate when it only
    // appears inside a larger GROUP BY expression, so every query below
    // groups in a subquery and aggregates the derived column. The summary
    // query above already worked because it only counted.
    const groups = await prisma.$queryRaw<
      Array<{
        copies: bigint;
        sample_artist: string;
        sample_track: string | null;
        user_id: number;
        time_played: Date;
        play_source: string | null;
      }>
    >`
      SELECT
        count(*)::bigint       AS copies,
        min(d.artist_name)     AS sample_artist,
        min(d.track_name)      AS sample_track,
        min(d.user_id)         AS user_id,
        min(d.time_played)     AS time_played,
        min(d.play_source::text) AS play_source
      FROM (
        SELECT ${ident()} AS ident,
               artist_name, track_name, user_id, time_played, play_source,
               count(*) AS c
        FROM user_plays
        GROUP BY 1, artist_name, track_name, user_id, time_played, play_source
        HAVING count(*) > 1
      ) d
      ORDER BY copies DESC
      LIMIT 15
    `;

    if (groups.length) {
      console.log('\n=== worst duplicate groups (copies of one play) ===');
      for (const row of groups) {
        console.log(
          `  ${String(row.copies).padStart(4)}x  user ${String(row.user_id).padStart(8)}  ` +
            `${row.time_played ? row.time_played.toISOString() : '(null)'}  ${row.play_source ?? '-'}  ` +
            `${row.sample_artist} - ${row.sample_track ?? '(no track)'}`,
        );
      }
    }

    // An import-driven cluster points at the importer; a spread across LastFm
    // points at the sync race.
    const bySource = await prisma.$queryRaw<
      Array<{ play_source: string | null; dup_keys: bigint; extra_rows: bigint }>
    >`
      SELECT
        d.play_source::text            AS play_source,
        count(*)::bigint                AS dup_keys,
        coalesce(sum(d.c - 1), 0)::bigint AS extra_rows
      FROM (
        SELECT ${ident()} AS ident, play_source, count(*) AS c
        FROM user_plays
        GROUP BY 1, play_source
        HAVING count(*) > 1
      ) d
      GROUP BY d.play_source::text
      ORDER BY extra_rows DESC
    `;

    if (bySource.length) {
      console.log('\n=== duplicate rows by play_source ===');
      for (const row of bySource) {
        console.log(`  ${String(row.extra_rows).padStart(6)} extra  ${row.play_source ?? '(null)'}`);
      }
    }

    const users = await prisma.$queryRaw<Array<{ affected: bigint }>>`
      SELECT count(DISTINCT d.user_id)::bigint AS affected
      FROM (
        SELECT ${ident()} AS ident, user_id
        FROM user_plays
        GROUP BY 1, user_id
        HAVING count(*) > 1
      ) d
    `;
    console.log(`\n  users affected: ${users[0]?.affected ?? 0n}`);

    console.log('\nThis script changed nothing. See PLAN_B_PLUS_TO_A.md task 1.2 step 2 for');
    console.log('the cleanup migration and the unique index.');
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`Failed to count duplicate plays: ${detail || '(no message)'}`);
  if (err && typeof err === 'object' && 'code' in err) {
    console.error(`  prisma code: ${String((err as { code: unknown }).code)}`);
  }
  process.exitCode = 1;
});

