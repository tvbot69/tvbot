import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The browser-rendering suite, split out from the unit run.
 *
 * These three files construct a real PuppeteerService, launch Chromium, and
 * assert on real PNG bytes. A chart generator that silently emits a blank image
 * is a real user-facing bug, so they are worth having — but they mean the
 * default `npm test` cannot pass without a browser installed.
 *
 * So the unit suite excludes them and this config includes only them. CI runs
 * both in separate jobs, so a missing Chromium fails the render job rather than
 * every other test.
 *
 * `puppeteerBackpressure.test.ts` and `puppeteerProfileLeak.test.ts` stay in
 * the UNIT suite: they mock launchBrowser and need no browser. That was
 * checked, not assumed — the plan described 7 browser tests, and 3 files
 * actually launch one.
 *
 * Chromium is slow to start, so the timeouts are generous: a cold CI runner
 * should fail on a real defect, not on a timeout.
 */
export default defineConfig({
  test: {
    ...base.test,
    include: ['src/**/*.render.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: base.resolve,
});
