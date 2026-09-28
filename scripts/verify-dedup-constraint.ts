/**
 * Prove the dedup index actually REJECTS a duplicate, not merely that it exists.
 *
 * An index being present is not the same as the guarantee holding. This runs the
 * insert inside an explicit transaction and ROLLS BACK, so nothing persists -
 * it writes and then undoes it, on purpose, to observe the constraint.
 *
 * Safe against production: the ROLLBACK is unconditional, including on the
 * failure path, which is the whole reason the test is written this way.
 *
 * Usage: npx tsx scripts/verify-dedup-constraint.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Row {
  user_play_id: bigint;
  user_id: number;
  time_played: Date;
  artist_name: string;
  track_name: string | null;
  play_source: string | null;
}

const INSERT = `
  INSERT INTO user_plays ("user_play_id", "user_id", "time_played", "artist_name", "track_name", "play_source")
  VALUES ($1, $2, $3, $4, $5, $6::"PlaySource")`;

const main = async (): Promise<void> => {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT "user_play_id", "user_id", "time_played", "artist_name", "track_name",
            "play_source"::text AS "play_source"
       FROM user_plays ORDER BY "user_play_id" DESC LIMIT 1`,
  );
  if (rows.length === 0) {
    console.error('user_plays is empty; cannot test the constraint against a real row.');
    process.exit(1);
  }
  const row = rows[0];
  console.log(
    `\nusing row user_play_id=${row.user_play_id} user_id=${row.user_id} ` +
      `artist="${row.artist_name}" source=${row.play_source}`,
  );

  const attempt = async (
    idOffset: bigint,
    timeOffsetMs: number,
  ): Promise<string | null> => {
    await prisma.$queryRawUnsafe('BEGIN');
    try {
      await prisma.$queryRawUnsafe(
        INSERT,
        row.user_play_id + idOffset,
        row.user_id,
        new Date(row.time_played.getTime() + timeOffsetMs),
        row.artist_name,
        row.track_name,
        row.play_source,
      );
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      await prisma.$queryRawUnsafe('ROLLBACK');
    }
  };

  // 1. Control: a DIFFERENT identity - same row, one second later - MUST be
  //    accepted. This is the check that the index is not simply rejecting
  //    everything.
  //
  //    Note the id is NOT varied to make a row distinct, because the indexed
  //    identity deliberately excludes user_play_id. That was this script's first
  //    assumption and it was wrong: the control was rejected, correctly, because
  //    two rows with the same user/time/artist/track/source ARE duplicates
  //    whatever their ids. The trade-off is intentional - see the migration
  //    comment - and this is the test that documents it.
  const control = await attempt(900000001n, 1000);
  if (control !== null) {
    console.error(`\ncontrol insert was rejected, so the test is invalid: ${control.slice(0, 120)}`);
    process.exit(1);
  }
  console.log('control insert (identity shifted by 1s): accepted, as expected');

  // 2. The real test: an exact duplicate of the identity must be rejected.
  const dup = await attempt(900000002n, 0);
  if (dup === null) {
    console.error('\nFAILED: a duplicate identity was accepted. The index is not enforcing it.');
    process.exit(1);
  }
  const code = /23505/.test(dup) ? '23505 unique_violation' : dup.slice(0, 60);
  console.log(`duplicate insert (same identity): REJECTED (${code})`);
  console.log('\nOK: the guarantee holds. Nothing persisted - both inserts were rolled back.');
};

main()
  .catch((e: unknown) => {
    console.error('verification failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
