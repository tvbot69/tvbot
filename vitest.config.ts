import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `*.render.test.ts` launches a real Chromium via PuppeteerService and
    // asserts on real PNG bytes, so it is excluded from the default run: the unit
    // suite must pass with no browser installed. `npm run test:render` runs
    // these, and CI has a separate job for them. The two `puppeteer*.test.ts`
    // files stay in the default run because they MOCK launchBrowser - verified,
    // not assumed.
    //
    // Coverage is a deliberate exception: `npm run test:coverage` passes
    // --render, which pulls the render files back in. They exercise real
    // product code, so excluding them from the measurement would under-report it
    // - and the first attempt at this lowered the baseline by a full point
    // purely because of the exclusion.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.render.test.ts'],
    passWithNoTests: true,
    // Runs before any test module is imported, which is the only point that
    // works: `configData`'s lazy `Data` getter calls assertValidEnvironment()
    // and `prismaClient` touches it at module scope, so the check fires during
    // the import graph rather than when a test runs.
    setupFiles: ['./src/testSupport/setupEnv.ts'],

    // Coverage is a RATCHET, not a report: CI fails if any of these drop, and
    // they only ever go up.
    //
    // Measured with `all: true` so that files nobody has tested still count
    // against the denominator - without it, an untested file silently stops
    // counting and coverage rises by shrinking the denominator rather than by
    // adding tests.
    //
    //   lines 91.61%  branches 87.17%  functions 87.71%  statements 91.61%
    // (57,294 statements in src/, 9,148 unit tests, 2026-10-01, re-measured
    // after the tree cleanup in 941ed51. Coverage run includes the 3 render
    // files; the plain unit run excludes them.)
    //
    // Thresholds sit just below each, so a 0.1% regression fails the build.
    // They used to sit far BELOW reality (66.5 while the code was at 74.08), which
    // made the ratchet a floor nobody could trip. Measure, then set.
    coverage: {
      provider: 'v8',
      all: true,
      // Explicit file set rather than a root glob.
      //
      // With `all: true` and no `include`, v8 walked the whole project root and
      // picked up 14 DELETED source files out of stale build artifacts - they
      // exist as .js.map sources under dist/ and nowhere else. They were not in
      // git and not on disk in src/, and all 14 were scored 0%, so they sat in
      // the denominator inflating it by ~1360 statements and deflating the
      // reported figure by about two points.
      //
      // Scoping to src/ is the fix, and it is robust to the cause rather than
      // dependent on diagnosing it: the report can only ever describe product
      // source.
      include: ['src/**/*.ts'],
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportOnFailure: true,
      // Test files are not product code, so they must not sit in the
      // denominator at 0%.
      //
      // Both slash styles are listed on purpose: the first version used
      // forward slashes only, which silently matched nothing on Windows where
      // the coverage keys are backslash-separated. 141 test files were being
      // counted as untested product code, which deflated the baseline by
      // several points and would have made the ratchet both wrong and unfair.
      // A second Windows-only contributor is worth a real number.
exclude: [
        '**/*.{test,spec}.{ts,tsx,js,jsx}',
        '**\\*.{test,spec}.{ts,tsx,js,jsx}',
        // Shared harness code, not product: dbHarness, the setup file and the
        // uncooperative player double. It was `src/tests/**` before the tree
        // cleanup moved it to `src/testSupport/`; leaving the old path would
        // have silently put four test-infrastructure files into the coverage
        // denominator at 0%, which is the same class of mistake as counting
        // the 141 test files that this list exists to exclude.
        'src/testSupport/**',
        'src\\testSupport\\**',
        '**/*.d.ts',
        '**\\*.d.ts',
        'coverage/**',
        'scripts/**',
      ],
      thresholds: {
        statements: 91.5,
        branches: 86.9,
        functions: 87.5,
        lines: 91.5,
      },
    },
  },
  resolve: {
    alias: {
      '@bot': new URL('./src/bot', import.meta.url).pathname,
      '@domain': new URL('./src/domain', import.meta.url).pathname,
      '@lastfm': new URL('./src/lastfm', import.meta.url).pathname,
      '@persistence': new URL('./src/persistence', import.meta.url).pathname,
      '@images': new URL('./src/images', import.meta.url).pathname,
      '@applemusic': new URL('./src/applemusic', import.meta.url).pathname,
      '@spotify': new URL('./src/spotify', import.meta.url).pathname,
      '@deezer': new URL('./src/deezer', import.meta.url).pathname,
      '@config': new URL('./src/config', import.meta.url).pathname,
    },
  },
});
