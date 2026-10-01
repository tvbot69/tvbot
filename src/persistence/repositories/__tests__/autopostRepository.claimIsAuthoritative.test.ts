import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AutopostRepository } from '@persistence/repositories/autopostRepository';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import type { MusicTrack } from '@domain/models/music/musicTrack';

/**
 * A2: "no dead feature presents itself as working."
 *
 * This file exists because three `lastPosted` writers and one `clearHistory`
 * were deleted as unreachable, and a deletion with no test is a deletion with
 * no proof - the suite stays green whether the code is needed or not, which is
 * precisely the failure mode A2 is about.
 *
 * WHAT WAS REMOVED, AND WHY THE SURVIVORS MATTER
 * ----------------------------------------------
 *
 * `AutopostRepository` had THREE methods that write `lastPosted`:
 *
 *   - `updateLastPosted(id, when)`  - DELETED. Never called. It is a blind
 *     `update` with no `enabled` check and no due-check, so it is a
 *     read-modify-write that races the sweep that actually posts.
 *   - `claimDueAutopost(id, due)`  - the real one. Conditional `updateMany`,
 *     so two runners cannot both win.
 *   - `releaseClaim(id, previous)` - the rollback for a failed post.
 *
 * Two writers of the same column is the hazard, not the dead one: if
 * `updateLastPosted` had been the one that survived, an autopost could be
 * re-posted forever because nothing would ever check whether it was due. The
 * tests below pin the CONDITIONAL claim specifically - `enabled: true` and the
 * `OR: [lastPosted null, lastPosted <= dueBefore]` guard are the whole reason a
 * scheduled post is not re-sent every 15 minutes.
 *
 * `getAutopostById` was also deleted (no callers; the sweep reads every active
 * autopost in one `findMany` and never looks one up by id).
 *
 * `MusicHistoryRepository.clearHistory` was deleted (no callers). Its own
 * sibling comment records why it mattered: with nothing to evict a guild's
 * entry, the map grew one entry per guild for the life of the process. The
 * eviction cap in `addHistory` is the live half of that fix and is now the only
 * bound, so it is pinned below.
 */

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  guildId: 1n,
  channelId: 2n,
  contentType: 'top',
  schedule: 'daily',
  enabled: true,
  lastPosted: null,
  created: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

/** A Prisma double for the one model this repository touches. */
const makePrisma = (seed: Record<string, unknown>[] = [row()]) => {
  const state = { rows: seed.map((r) => ({ ...r })) };
  return {
    state,
    guildAutopost: {
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) => {
        const found = state.rows.find((r) => r.id === where.id);
        return found ? { lastPosted: found.lastPosted, enabled: found.enabled } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const found = state.rows.find((r) => r.id === where.id);
        if (!found) throw new Error(`no autopost ${where.id}`);
        Object.assign(found, data);
        return found;
      }),
      /**
       * Evaluates the `where` clause GENERICALLY.
       *
       * Two earlier versions of this double were wrong, and both were wrong in
       * the way that matters: they passed the mutation check they should have
       * failed.
       *
       *  1. It hard-picked the two conditions it expected (`enabled`, and the
       *     due-check) and ignored everything else. Adding a bogus extra
       *     condition to `claimDueAutopost`'s `where` left all nine tests green.
       *  2. Fixed to walk the clause, it recursed `OR` with the CONDITION
       *     FRAGMENT in the slot meant for the RECORD, so `r.id` was undefined,
       *     the `id` comparison failed, and every claim returned count 0 - two
       *     tests red. That one at least failed loudly; the danger is the
       *     shape of the bug, not its symptom.
       *
       * `matchesRow(record, condition)` keeps the two apart: the record is
       * always the same row, and only the condition tree varies. An operator
       * the double does not model throws, rather than quietly returning true.
       */
      updateMany: vi.fn(async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
        const matchesRow = (rec: Record<string, unknown>, cond: Record<string, unknown>): boolean => {
          for (const [key, value] of Object.entries(cond)) {
            if (key === 'AND') {
              if (!(value as unknown[]).every((sub) => matchesRow(rec, sub as Record<string, unknown>))) return false;
              continue;
            }
            if (key === 'OR') {
              if (!(value as unknown[]).some((sub) => matchesRow(rec, sub as Record<string, unknown>))) return false;
              continue;
            }
            // A scalar compares by identity; an object is an operator map.
            if (value === null || typeof value !== 'object') {
              if (rec[key] !== value) return false;
              continue;
            }
            for (const [op, expected] of Object.entries(value as Record<string, unknown>)) {
              const actual = rec[key];
              const isDate = actual instanceof Date && expected instanceof Date;
              switch (op) {
                case 'lte':
                  if (!isDate || actual > (expected as Date)) return false;
                  break;
                case 'lt':
                  if (!isDate || actual >= (expected as Date)) return false;
                  break;
                case 'gte':
                  if (!isDate || actual < (expected as Date)) return false;
                  break;
                case 'gt':
                  if (!isDate || actual <= (expected as Date)) return false;
                  break;
                case 'not':
                  if (actual === expected) return false;
                  break;
                default:
                  throw new Error(
                    `double cannot model operator "${op}" - a test is asserting against a query shape this double does not understand`,
                  );
              }
            }
          }
          return true;
        };
        const hit = state.rows.filter((r) => matchesRow(r, where as Record<string, unknown>));
        if (hit.length === 0) return { count: 0 };
        for (const h of hit) Object.assign(h, data);
        return { count: hit.length };
      }),
    },
  };
};

describe('AutopostRepository.claimDueAutopost (the only lastPosted writer)', () => {
  const DUE = new Date('2026-01-01T00:00:00Z');

  it('claims a never-posted autopost and reports no previous value', async () => {
    const prisma = makePrisma([row({ lastPosted: null })]);
    const repo = new AutopostRepository(prisma as never);

    const previous = await repo.claimDueAutopost(1, DUE);

    expect(previous).toBeUndefined();
    expect(prisma.state.rows[0]!.lastPosted).toBeInstanceOf(Date);
  });

  it('REFUSES a disabled autopost and does not stamp it', async () => {
    const prisma = makePrisma([row({ enabled: false, lastPosted: null })]);
    const repo = new AutopostRepository(prisma as never);

    const previous = await repo.claimDueAutopost(1, DUE);

    expect(previous).toBeNull();
    expect(prisma.state.rows[0]!.lastPosted).toBeNull();
  });

  it('REFUSES an autopost already posted after the due cutoff, and leaves lastPosted alone', async () => {
    const alreadyPosted = new Date('2026-01-01T06:00:00Z');
    const prisma = makePrisma([row({ lastPosted: alreadyPosted })]);
    const repo = new AutopostRepository(prisma as never);

    const previous = await repo.claimDueAutopost(1, DUE);

    expect(previous).toBeNull();
    // The value is the one the row already had, NOT a fresh stamp. A claim that
    // "fails" but still writes is what re-posts a guild every sweep.
    expect(prisma.state.rows[0]!.lastPosted).toEqual(alreadyPosted);
  });

  it('reports the previous lastPosted so a failed post can be rolled back', async () => {
    const previousPost = new Date('2025-12-31T00:00:00Z');
    const prisma = makePrisma([row({ lastPosted: previousPost })]);
    const repo = new AutopostRepository(prisma as never);

    const claimed = await repo.claimDueAutopost(1, DUE);

    expect(claimed).toEqual(previousPost);
    expect(prisma.state.rows[0]!.lastPosted).not.toEqual(previousPost);

    await repo.releaseClaim(1, claimed);
    expect(prisma.state.rows[0]!.lastPosted).toEqual(previousPost);
  });

  it('releaseClaim writes null for a never-posted autopost, not undefined', async () => {
    const prisma = makePrisma([row({ lastPosted: new Date('2026-01-01T06:00:00Z') })]);
    const repo = new AutopostRepository(prisma as never);

    await repo.releaseClaim(1, undefined);

    expect(prisma.state.rows[0]!.lastPosted).toBeNull();
  });
});

const track = (n: number): MusicTrack =>
  ({ identifier: `id${n}`, title: `t${n}`, author: `a${n}`, uri: '', duration: 1, isSeekable: true, isStream: false, artworkUrl: null, album: null, source: 'spotify', requester: 'u' }) as unknown as MusicTrack;

describe('MusicHistoryRepository (clearHistory deleted; the cap is the only bound)', () => {
  it('returns an honest empty for a guild it has never seen', () => {
    const repo = new MusicHistoryRepository();
    expect(repo.getHistory('never-seen', 10)).toEqual([]);
  });

  it('keeps the newest track first and honours the limit', () => {
    const repo = new MusicHistoryRepository();
    repo.addHistory('g1', track(1));
    repo.addHistory('g1', track(2));
    repo.addHistory('g1', track(3));

    const all = repo.getHistory('g1', 10);
    expect(all.map((i) => i.track.title)).toEqual(['t3', 't2', 't1']);
    expect(repo.getHistory('g1', 2).map((i) => i.track.title)).toEqual(['t3', 't2']);
  });

  it('caps a single guild at 50 entries', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < 60; n += 1) repo.addHistory('g1', track(n));

    const all = repo.getHistory('g1', 1000);
    expect(all).toHaveLength(50);
    // The cap drops the OLDEST, so the newest is still the one at the head.
    expect(all[0]?.track.title).toBe('t59');
  });

  it('does not grow a second entry for a guild it already tracks', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < 200; n += 1) repo.addHistory('g1', track(n));

    expect(repo.getHistory('g1', 1000)).toHaveLength(50);
  });
});
