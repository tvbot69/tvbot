import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The real-Postgres suite, split out from the unit run.
 *
 * These tests open a socket. Everything else in this repo mocks the database,
 * which is why 28 `$queryRawUnsafe` calls could sit there unexecuted: a
 * renamed column or a GROUP BY Postgres rejects is a RUNTIME failure with a
 * perfectly green build and a perfectly green unit suite.
 *
 * So they run only where a real Postgres exists - the `migrations` CI job,
 * which already has postgres:16 and has applied every migration. `npm test`
 * must stay runnable with no database, which is why this is a separate config
 * rather than a conditional inside the default one.
 *
 * Skipped with a clear message when TEST_DATABASE_URL is absent, so a
 * contributor without a database gets a skip and not a wall of errors.
 */
export default defineConfig({
  test: {
    ...base.test,
    include: ['src/**/*.db.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Real database round-trips, and serial runs: they share one schema.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: base.resolve,
});
