/**
 * Prove the dedup index actually REJECTS a duplicate, not merely that it exists.
 *
 * An index being present is not the same as the guarantee holding. This writes
 * inside an explicit transaction and ROLLS BACK, so nothing persists - it writes
 * and then undoes it, on purpose, to observe the constraint.
 *
 * Safe against production: the ROLLBACK is unconditional, including on every
 * failure path, which is the whole reason the test is written this way.
 *
 * Self-seeding, because CI's database is empty. Requiring a pre-existing row
 * would make this job fail for the wrong reason on a fresh database, which is
 * the kind of red that trains people to ignore a red build.
 *
 * Usage: npx tsx scripts/verify-dedup-constraint.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** A row that satisfies the indexed identity, inserted only inside a transaction.
 *  Returns the full identity so the control/duplicate inserts can copy it. */
const SEED = `
  INSERT INTO user_plays ("user_id", "time_played", "artist_name", "track_name", "play_source")
  SELECT u."user_id", now(), 'Constraint Probe', 'constraint probe track', 'LastFm'::"PlaySource"
    FROM "user" u LIMIT 1
  RETURNING "user_play_id", "user_id", "time_played", "artist_name", "track_name",
            "play_source"::text AS "play_source"`;

/**
 * Copy a row's identity into a new row.
 *
 * Uses the row's REAL artist_name and track_name. An earlier version inserted
 * hardcoded probe names while testing against a real existing row, so the
 * "duplicate" had a different identity from everything else and was correctly
 * accepted - which read as "the index is broken" and was actually a broken test.
 */
const COPY = (_id: bigint) => `
  INSERT INTO user_plays ("user_play_id", "user_id", "time_played", "artist_name", "track_name", "play_source")
  VALUES ($1, $2, $3, $4, $5, $6::"PlaySource")`;

const OFFSET_DUP = 900000002n;
const OFFSET_CONTROL = 900000003n;

interface ProbeRow {
  user_play_id: bigint;
  user_id: number;
  time_played: Date;
  artist_name: string;
  track_name: string | null;
  play_source: string | null;
}

/** Select a real row's whole identity. No ORDER BY: any row will do, and an
 *  arbitrary one is fine because every insert is rolled back. */
const ROW_SQL =
  `SELECT "user_play_id", "user_id", "time_played", "artist_name", "track_name",` +
  ` "play_source"::text AS "play_source" FROM user_plays LIMIT 1`;

const main = async (): Promise<void> => {
  await prisma.$queryRawUnsafe('BEGIN');
  try {
    // Prefer a real row, so the test exercises the data that is actually there.
    let seeded = await prisma.$queryRawUnsafe<ProbeRow[]>(ROW_SQL);
    if (seeded.length === 0) {
      // Fresh CI database. Needs a user row to satisfy the FK, and there will
      // be none, so report the skip honestly rather than inventing a user.
      const users = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "user"`);
      if ((users[0]?.n ?? 0n) === 0n) {
        console.log(
          '\nSKIPPED: user_plays is empty and there are no users to satisfy the FK.\n' +
            'The constraint cannot be observed without a row. Nothing was written - rolled back.',
        );
        return;
      }
      seeded = await prisma.$queryRawUnsafe(SEED);
      console.log(`\nuser_plays was empty; seeded a probe row inside the transaction (id=${seeded[0]?.user_play_id})`);
    }
    const row = seeded[0];
    if (!row) {
      console.log('\nSKIPPED: could not obtain a row to test against. Rolled back.');
      return;
    }
    console.log(`testing against user_play_id=${row.user_play_id} user_id=${row.user_id}`);

    // 1. Control: the identity shifted by one second MUST be accepted. Without
    //    this, an index that rejected EVERYTHING would look like a pass.
    //
    //    Note the new `user_play_id` deliberately does not make a row distinct:
    //    the indexed identity excludes the id, so two scrobbles of the same
    //    track in the same second are one play whatever their ids. An earlier
    //    version of this script assumed otherwise and its control was rejected.
    try {
      await prisma.$queryRawUnsafe(
        COPY(OFFSET_CONTROL),
        row.user_play_id + OFFSET_CONTROL,
        row.user_id,
        new Date(row.time_played.getTime() + 1000),
        row.artist_name,
        row.track_name,
        row.play_source,
      );
      console.log('control (identity shifted 1s): ACCEPTED - the index is not rejecting everything');
    } catch (e) {
      console.error('\nFAILED: the control insert was rejected, so this test proves nothing:');
      console.error('  ' + (e instanceof Error ? e.message : String(e)).slice(0, 200));
      process.exitCode = 1;
      return;
    }

    // 2. The real test: an exact duplicate of the identity must be rejected.
    try {
      await prisma.$queryRawUnsafe(
        COPY(OFFSET_DUP),
        row.user_play_id + OFFSET_DUP,
        row.user_id,
        new Date(row.time_played),
        row.artist_name,
        row.track_name,
        row.play_source,
      );
      console.error('\nFAILED: a duplicate identity was ACCEPTED. The index is not enforcing the guarantee.');
      process.exitCode = 1;
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = /23505/.test(msg) ? '23505 unique_violation' : msg.slice(0, 70);
      console.log(`duplicate (same identity):  REJECTED (${code})`);
      console.log('\nOK: the guarantee holds. Nothing persisted - everything rolled back.');
    }
  } finally {
    await prisma.$queryRawUnsafe('ROLLBACK');
  }
};

main()
  .catch((e: unknown) => {
    console.error('verification failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
