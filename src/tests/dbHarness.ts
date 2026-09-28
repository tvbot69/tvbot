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
    // discord_user_id is a BIGINT: a non-numeric literal is 22P02 at runtime.
    `INSERT INTO users ("user_id", "user_name_last_fm", "discord_user_id")
     VALUES ($1, $2, $3) ON CONFLICT ("user_id") DO NOTHING`,
    userId,
    `db_user_${userId}`,
    String(BigInt(userId) * 1000n),
  );
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

/** A unique-enough user id per test file so parallel files cannot collide. */
export const testUserId = (): number =>
  Math.floor(Date.now() % 1_000_000) * 10 + Math.floor(Math.random() * 9);
