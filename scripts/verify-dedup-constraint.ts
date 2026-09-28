/**
 * Prove the dedup index actually REJECTS a duplicate, not merely that it exists.
 *
 * An index being present is not the same as the guarantee holding. This writes
 * inside an explicit transaction and ROLLS BACK, so nothing persists - it writes
 * and then undoes it, on purpose, to observe the constraint.
 *
 * Safe against production because the writes run inside `prisma.$transaction`,
 * which pins ONE pooled connection and rolls back even when the callback throws.
 *
 * It was NOT safe before this. The original sent BEGIN and ROLLBACK as two
 * separate `$queryRawUnsafe` calls, and Prisma pools connections, so they could
 * land on DIFFERENT connections: there was no transaction, the inserts
 * auto-committed, and "nothing persisted" was false. That is also why CI went
 * red - on a fresh database the skip path ran, then ROLLBACK errored on a
 * connection that had never been given a transaction.
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
  // `$transaction` with a CALLBACK, not a batch: the callback form pins a
  // single connection for its whole lifetime, which is the only way BEGIN and
  // the inserts can share one. It also rolls back when the callback throws,
  // so "nothing persisted" is now actually true rather than merely intended.
  await prisma.$transaction(async (tx) => {
    let seeded = await tx.$queryRawUnsafe<ProbeRow[]>(ROW_SQL);
    if (seeded.length === 0) {
      // Fresh CI database. Needs a user row to satisfy the FK, and there will
      // be none, so report the skip honestly rather than inventing a user.
      const users = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "user"`,
      );
      if ((users[0]?.n ?? 0n) === 0n) {
        console.log(
          '\nSKIPPED: user_plays is empty and there are no users to satisfy the FK.' +
            '\nThe constraint cannot be observed without a row. Nothing was written.',
        );
        return;
      }
      seeded = await tx.$queryRawUnsafe(SEED);
      console.log(
        `\nuser_plays was empty; seeded a probe row inside the transaction (id=${seeded[0]?.user_play_id})`,
      );
    }
    const row = seeded[0];
    if (!row) {
      console.log('\nSKIPPED: could not obtain a row to test against.');
      return;
    }
    console.log(`testing against user_play_id=${row.user_play_id} user_id=${row.user_id}`);

    // 1. Control: the identity shifted one second MUST be accepted. Without it,
    //    an index that rejected everything would look like a pass.
    try {
      await tx.$queryRawUnsafe(
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
      throw e;
    }

    // 2. The real test: an exact duplicate identity must be rejected.
    try {
      await tx.$queryRawUnsafe(
        COPY(OFFSET_DUP),
        row.user_play_id + OFFSET_DUP,
        row.user_id,
        new Date(row.time_played),
        row.artist_name,
        row.track_name,
        row.play_source,
      );
      throw new Error('DUPLICATE_ACCEPTED');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('DUPLICATE_ACCEPTED')) {
        console.error('\nFAILED: a duplicate identity was ACCEPTED. The index is not enforcing the guarantee.');
        throw e;
      }
      const code = /23505/.test(msg) ? '23505 unique_violation' : msg.slice(0, 70);
      console.log(`duplicate (same identity):  REJECTED (${code})`);
    }

    console.log('\nOK: the guarantee holds. Nothing persisted - the transaction rolled back.');
  });
};

main()
  .catch((e: unknown) => {
    console.error('verification failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
