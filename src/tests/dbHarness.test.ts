import { describe, expect, it, vi } from 'vitest';

/**
 * The truncate guard, tested with no database at all.
 *
 * resetTables empties every table. Production is named "railway" and a
 * developer .env holds the real DATABASE_URL, so "someone pasted the wrong
 * variable" is a realistic accident rather than a theoretical one. The guard
 * has to refuse rather than warn, and it has to be proven before it is relied
 * on - a guard that only looks right in the source is not a guard.
 */

const loadSkipReason = async (url: string | undefined): Promise<string | undefined> => {
  if (url === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = url;
  // A fresh module instance, so each case re-reads the env rather than
  // inheriting the previous one. vi.resetModules does not help a statically
  // imported binding, hence the dynamic import.
  vi.resetModules();
  const mod = (await import('./dbHarness')) as { skipReason: () => string | undefined };
  return mod.skipReason();
};

describe('dbHarness skipReason', () => {
  it('skips when no URL is set', async () => {
    await expect(loadSkipReason(undefined)).resolves.toMatch(/not set/);
  });

  // The host here is a placeholder. The guard matches on the DATABASE NAME, not
  // on the host, so a placeholder is as strong a test as the real thing — and
  // this repo is public, so a real managed-database hostname must never be
  // committed even inside a fixture that is expected to be refused.
  it.each([
    ['postgresql://tvbot:tvbot@localhost:5432/tvbot?schema=public'],
    ['postgresql://u:p@managed-db.example.invalid:5432/railway'],
    ['postgresql://u:p@host/production'],
    ['postgresql://u:p@host/main'],
  ])('REFUSES the non-scratch database in %s', async (url) => {
    const reason = await loadSkipReason(url);
    expect(reason).toBeDefined();
    expect(reason).toMatch(/REFUSING/);
  });

  it.each([
    ['postgresql://tvbot:tvbot@localhost:5432/tvbot_test?schema=public'],
    ['postgresql://tvbot:tvbot@localhost:5432/test'],
    ['postgresql://tvbot:tvbot@localhost:5432/ci'],
    ['postgresql://tvbot:tvbot@localhost:5432/tvbot_scratch'],
    ['postgresql://tvbot:tvbot@localhost:5432/scratch_db'],
  ])('ALLOWS the scratch database in %s', async (url) => {
    await expect(loadSkipReason(url)).resolves.toBeUndefined();
  });

  it('refuses an unparseable URL rather than guessing', async () => {
    await expect(loadSkipReason('not-a-url')).resolves.toMatch(/REFUSING|parseable/);
  });
});
