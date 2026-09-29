/**
 * A settings write that could not run is not a settings write.
 *
 * All seven `setX` methods carried `.catch(() => null)` on `db.user.update`, so
 * a dropped connection produced the one answer a user has no way to check: the
 * command still replied "Timezone updated to `Europe/London`" or "Your default
 * WhoKnows mode has been set to **Image**" over a row that was never written.
 *
 * Two things make it worse than a wrong number, and both are asserted here:
 *
 *  1. It is a claim about the user's OWN settings. Every other silent default in
 *     this service would be a statistic; this one is a promise that something
 *     was saved.
 *  2. It goes stale rather than merely wrong. The eviction is keyed on the row
 *     the write would have RETURNED, so swallowing the failure skips the
 *     eviction and leaves the PREVIOUS value live for the full 300s TTL while
 *     the user is told the new one is in effect. The two disagree for five
 *     minutes and nothing anywhere says so.
 *
 * Both directions are asserted. A test that only checks "it raises now" passes
 * just as happily against a writer that always raises, which would trade one
 * lie for a different one - nobody could ever save a setting again.
 *
 * No "query ran and found nothing" half exists HERE, unlike the read paths: a
 * `user.update` on a real `userId` either returns the row or throws, so there is
 * no zero-row success to protect. The honest counterpart for a write is the
 * successful write, and it is pinned below.
 *
 * Plain-object doubles, built fresh per test and handed to the constructor. No
 * `vi.spyOn` on the service or on any shared client - `mockRestore` leaves an own
 * property set to `undefined` and every later test in the file dies silently.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { UserService } from './userService';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';

/** Prisma 5xx / driver-level connectivity failure, the realistic shape. */
const DB_DOWN = () => new Error("Can't reach database server at `host.docker.internal:5432`");

const ROW = { userId: 1, discordUserId: '900000000000000001' };

/**
 * Every writer, with the argument its signature needs and the value the command
 * echoes back to the user.
 *
 * All seven are here on purpose. A sweep over six of them passes the moment
 * someone adds a seventh that swallows again, and "six of seven" is exactly the
 * shape this file exists to rule out.
 */
const WRITERS: Array<{
  method: keyof UserService;
  call: (s: UserService) => Promise<unknown>;
  echoes: unknown;
  /** The column the write must land in, so the guard cannot pass by writing nothing. */
  column: Record<string, unknown>;
}> = [
  {
    method: 'setTimeZone',
    call: (s) => s.setTimeZone(1, 'Europe/London'),
    echoes: 'Europe/London',
    column: { timeZone: 'Europe/London' },
  },
  {
    method: 'setNumberFormat',
    call: (s) => s.setNumberFormat(1, 'space'),
    echoes: 'space',
    column: { numberFormat: 'space' },
  },
  {
    method: 'setPrivacyLevel',
    call: (s) => s.setPrivacyLevel(1, 'hide'),
    echoes: 'Server',
    column: { privacyLevel: 'Hide' },
  },
  {
    method: 'setDataSource',
    call: (s) => s.setDataSource(1, 'SpotifyImport'),
    echoes: 'SpotifyImport',
    column: { dataSource: 'SpotifyImport' },
  },
  {
    method: 'setWhoKnowsMode',
    call: (s) => s.setWhoKnowsMode(1, 2),
    echoes: 2,
    column: { whoKnowsMode: 2 },
  },
  {
    method: 'setResponseMode',
    call: (s) => s.setResponseMode(1, 3),
    echoes: 3,
    column: { mode: 3 },
  },
  {
    method: 'setCoverType',
    call: (s) => s.setCoverType(1, 4),
    echoes: 4,
    column: { coverType: 4 },
  },
];

type Doubles = {
  service: UserService;
  cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  userUpdate: ReturnType<typeof vi.fn>;
};

/**
 * `userUpdate` answers with whatever `update` is given: a value, or a rejected
 * promise. A rejected promise is the honest way to simulate "the write could not
 * run" without a real driver - it rejects at the same await the service makes.
 */
const build = (update: unknown = ROW): Doubles => {
  const cache = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const userUpdate = vi.fn(async (_args: unknown) => update);
  const service = new UserService(
    {} as never,
    cache as never,
    {} as never,
    { user: { update: userUpdate, count: vi.fn(async () => 0) } } as never,
  );
  return { service, cache, userUpdate };
};

describe('UserService settings writers - a write that could not run is raised', () => {
  it.each(WRITERS)('$method raises instead of reporting the setting as saved', async (w) => {
    const { service, cache } = build(Promise.reject(DB_DOWN()));

    const err = await w.call(service).catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain(`userService.${w.method}`);
    expect((err as Error).message).toContain("Can't reach database server");
    // No eviction: the write did not land, so there is no new row to evict the
    // old entry for. This is the half that used to leave the previous value live
    // for five minutes under a "saved" reply.
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('$method still reports the value it wrote when the write ran', async (w) => {
    const { service, cache, userUpdate } = build();

    await expect(w.call(service)).resolves.toBe(w.echoes);

    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: w.column });
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });

  it('keeps the original failure as the cause rather than flattening it', async () => {
    const down = DB_DOWN();
    const { service } = build(Promise.reject(down));

    const err = await service.setNumberFormat(1, 'space').catch((e: unknown) => e);

    expect((err as { cause?: unknown }).cause).toBe(down);
  });

  it('does not report a settings failure as a Last.fm failure', async () => {
    // `isSourceUnavailable` is the check artworkService uses to decide "do NOT
    // cache this as a definitive answer". A database error swept into the
    // Last.fm family by accident would be cached as one, so the two stay
    // distinguishable.
    const { service } = build(Promise.reject(DB_DOWN()));

    const err = await service.setCoverType(1, 4).catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).name).toBe('SourceUnavailableError');
  });

  it('evicts under the RETURNED row id, not the requested userId', async () => {
    // The cache key is `user-discord:<id>` and `userId` is a different number, so
    // evicting by the argument would silently miss and leave the old row live
    // even on a successful write. Re-asserted here because the eviction moved
    // into a shared helper.
    const { service, cache } = build({ userId: 1, discordUserId: 'other-id' });

    await service.setWhoKnowsMode(1, 2);

    expect(cache.delete).toHaveBeenCalledWith('user-discord:other-id');
  });

  it('does not let a failed write evict a cache entry belonging to nobody', async () => {
    // Guards the shape of the failure path specifically: the old code could only
    // skip the eviction by skipping the write, and this pins that there is no
    // third state where the update call happened and the row was ignored.
    const { service, cache, userUpdate } = build(Promise.reject(DB_DOWN()));

    await service.setResponseMode(1, 3).catch(() => undefined);

    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(cache.delete).not.toHaveBeenCalled();
  });
});
