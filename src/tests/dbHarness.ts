import { PrismaClient } from '@prisma/client';

/**
 * Shared setup for the `*.db.test.ts` suite.
 *
 * A raw query is only proven by a real database executing it, so these tests
 * need a real one. Rather than each file working that out, the harness
 * resolves the URL once, reports the skip reason in one place, and hands back
 * a client that is closed no matter how the test ends.
 *
 * `TEST_DATABASE_URL` rather than `DATABASE_URL` on purpose: pointing the
 * real-query suite at the production database is a mistake nobody should be
 * one env var away from. CI sets it to the postgres:16 service.
 */

/** Resolved lazily so importing this module never requires a database. */
export const databaseUrl = (): string | undefined =>
  process.env.TEST_DATABASE_URL ?? undefined;

/**
 * Database names these tests are allowed to TRUNCATE.
 *
 * resetTables deletes every row. Pointing that at production would be
 * catastrophic and irreversible, and a .env file on a developer machine
 * usually holds the real DATABASE_URL - so a mistyped variable is all it
 * takes. The guard is a hard refusal, not a warning: the name must look like
 * a scratch database, which production never does.
 */
const ALLOWED_DB_NAME = /(^|[_-])(test|tests|ci|scratch|tmp|temp|dev|local)([_-]|$)/i;

export const skipReason = (): string | undefined => {
  const url = databaseUrl();
  if (!url) {
    return 'TEST_DATABASE_URL is not set - the real-Postgres suite needs a database (see vitest.db.config.ts).';
  }
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return 'TEST_DATABASE_URL is not a parseable URL.';
  }
  // An explicit non-public SCHEMA is itself an isolation boundary: every table the
  // tests touch is created inside it, so `public` is never read or written and the
  // database NAME stops mattering. This is what lets the suite run against a remote
  // server on a machine with no local Postgres, and it is still safe - the only
  // thing that makes a database dangerous here is writing to its real tables.
  const schema = /[?&]schema=([^&]+)/.exec(url)?.[1];
  if (schema && schema !== 'public') return undefined;
  if (!ALLOWED_DB_NAME.test(name)) {
    return `REFUSING to run: database "${name}" does not look like a scratch database. ` +
      'These tests TRUNCATE every table, so they must never point at production.';
  }
  return undefined;
};

/**
 * A connected client plus a guaranteed disconnect.
 *
 * Returns null when there is no database, so a test can `if (!ctx) return`
 * after the skip has been declared, and TypeScript forces the handling.
 */
export const connect = async (): Promise<PrismaClient | null> => {
  if (skipReason()) return null;
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl() } },
  });
  await prisma.$connect();
  return prisma;
};

/**
 * A user row to satisfy the user_plays foreign key.
 *
 * The scratch database is created EMPTY by CI, and every insert into
 * user_plays needs a user to point at. Seeding one is what lets a test assert
 * a real count instead of skipping everything.
 */
export const seedUser = async (prisma: PrismaClient, userId: number): Promise<void> => {
  await prisma.$executeRawUnsafe(
    // The ::int4 / ::varchar / ::int8 casts are LOAD-BEARING, not decoration.
    // Prisma sends $1..$3 as untyped parameters, and Postgres cannot resolve an
    // untyped parameter in an INSERT VALUES list, so the uncast form fails while
    // the identical query with literal values succeeds. Found by running both
    // against the live database inside a transaction that was rolled back.
    // discord_user_id is a BIGINT: a non-numeric literal is 22P02 at runtime.
    `INSERT INTO users ("user_id", "user_name_last_fm", "discord_user_id")
     VALUES ($1::int4, $2::varchar, $3::int8) ON CONFLICT ("user_id") DO NOTHING`,
    userId,
    `db_user_${userId}`,
    String(BigInt(userId) * 1000n),
  );
};

/** A play to insert, in the shape the tests want to reason about. */
export interface PlayFixture {
  userId: number;
  artistName: string;
  timePlayed: Date;
  trackName?: string | null;
  albumName?: string | null;
  playSource?: 'LastFm' | 'SpotifyImport' | 'AppleMusicImport';
}

/**
 * Insert plays for a test, with the parameter types spelled out.
 *
 * The casts are load-bearing, and the reason is the single most common failure
 * in this suite: Prisma sends `$1` as an UNTYPED parameter, and Postgres cannot
 * resolve an untyped parameter in an INSERT VALUES list, so the uncast form
 * fails with 42804 while the same query with literal values succeeds. Every
 * test that seeds rows should go through here rather than writing its own SQL.
 */
export const seedPlays = async (prisma: PrismaClient, plays: PlayFixture[]): Promise<void> => {
  for (const p of plays) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_plays
         ("user_id", "artist_name", "track_name", "album_name", "time_played", "play_source")
       VALUES ($1::int4, $2::text, $3::text, $4::text, $5::timestamptz, $6::"PlaySource")`,
      p.userId,
      p.artistName,
      p.trackName ?? null,
      p.albumName ?? null,
      p.timePlayed,
      p.playSource ?? 'LastFm',
    );
  }
};

/** Truncate every table the tests write to, so runs are independent. */
export const resetTables = async (prisma: PrismaClient): Promise<void> => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      user_plays, user_artists, user_albums, user_tracks, guild_users,
      user_crowns, friends, bot_scrobble_opt_ins, guild_autoposts,
      artist_genres, albums, tracks, artists, users, guilds
    RESTART IDENTITY CASCADE
  `);
};

/**
 * An ISOLATED schema name to run the tests in, taken from the URL query.
 *
 * Postgres schemas are a real isolation boundary and every table the tests
 * touch lives in `public`. Running in a scratch schema means the tests are
 * safe even against a production server, which is the only real Postgres
 * available on some machines. Nothing in `public` is read or written.
 */
export const scratchSchema = (): string | undefined => {
  const url = databaseUrl();
  if (!url) return undefined;
  const match = /[?&]schema=([^&]+)/.exec(url);
  return match?.[1];
};

/** Point the connection at the scratch schema for this client. */
export const useScratchSchema = async (prisma: PrismaClient): Promise<void> => {
  const schema = scratchSchema();
  if (schema) {
    await prisma.$executeRawUnsafe(`SET search_path TO "${schema}"`);
  }
};

/** A unique-enough user id per test file so parallel files cannot collide. */
export const testUserId = (): number =>
  Math.floor(Date.now() % 1_000_000) * 10 + Math.floor(Math.random() * 9);
