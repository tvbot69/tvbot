/**
 * Vitest setup: make the suite hermetic.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CI failed on its first run with 29 test files dying at IMPORT time:
 *
 *   [Config Error] DISCORD_TOKEN appears too short to be a valid Discord bot token.
 *   at buildSettings (src/bot/configurations/configData.ts:33)
 *   at Object.get Data (src/bot/configurations/configData.ts:118)
 *   at src/persistence/prismaClient.ts:56
 *
 * The cause is not a bad CI variable. It is that `npm test` only ever passed
 * locally because the developer's `.env` holds a real 30+ character token. A
 * fresh clone, or any machine without that file, fails the suite before a
 * single assertion runs. A test suite that cannot start without a developer's
 * personal secrets is not a test suite; it is a machine-local accident.
 *
 * `assertValidEnvironment()` runs from `configData`'s lazy `Data` getter, which
 * `prismaClient` touches at module scope. So the validation cannot be skipped
 * by "not booting the bot" - the import graph reaches it. Rather than weaken a
 * validator that is load-bearing in production, this supplies shape-valid,
 * obviously-fake values.
 *
 * NOTHING SECRET IS HERE, AND NOTHING OVERRIDES THE REAL ENVIRONMENT:
 * every assignment uses `??=`, so a value already present in `.env`, in CI, or
 * in the shell always wins. These are only fallbacks for a missing variable.
 */

/** Shape-valid but meaningless. A real Discord token is 59+ chars. */
const FAKE_DISCORD_TOKEN = 'test-only-not-a-real-token-0000000000000000';

const fallbacks: Record<string, string> = {
  DISCORD_TOKEN: FAKE_DISCORD_TOKEN,
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  LASTFM_API_KEY: 'test-key',
  LASTFM_API_SECRET: 'test-secret',
  SPOTIFY_CLIENT_ID: 'test-client-id',
  SPOTIFY_CLIENT_SECRET: 'test-client-secret',
  GENIUS_CLIENT_ID: 'test-genius-id',
  GENIUS_CLIENT_SECRET: 'test-genius-secret',
  YOUTUBE_API_KEY: 'test-youtube-key',
  // local keeps the Redis warning a warning rather than an error, and keeps
  // ENABLE_LAVALINK off by default so nothing reaches a public node.
  ENVIRONMENT: 'local',
  ENABLE_LAVALINK: 'false',
};

for (const [key, value] of Object.entries(fallbacks)) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}
