/**
 * The crown steal path, and the site the plan flags as the highest-stakes of
 * the set because the value produced by the catch is WRITTEN.
 *
 * `getHolderLivePlaycount` reads `lastfmRepository.getArtistInfo(artistName,
 * holderLastFmUsername)` - `artist.getInfo` with a username carries
 * `userplaycount`, so this is the one read that can say "the current holder has
 * actually caught up since their last index". The caller uses it to decide
 * whether a challenger may take the crown:
 *
 *     if (holderLive !== null && holderLive >= topUser.playcount) { keep holder }
 *     ... otherwise: replaceCrown(...)
 *
 * `catch { return null }` therefore meant: an unreachable Last.fm is
 * indistinguishable from "the holder is not ahead", so the steal went ahead and
 * `replaceCrown` was called. The row it writes names the challenger as the
 * holder and the real holder as dethroned, and the who-knows card then renders
 * `Crown stolen by <challenger> with 150 plays! Previous owner: <holder> with
 * 100 plays.` A permanent claim about two named people, produced from a read
 * that never returned.
 *
 * The narrowing is `isSourceUnavailable`, so the throw lands on the boundary at
 * `whoKnowsArtistService.getFilteredUsersForArtist` (which already catches crown
 * failures and renders the who-knows card with no crown) rather than writing a
 * wrong one.
 *
 * The EXISTING test `crownService.test.ts` covers a *non-raising* null, i.e. the
 * genuine-empty half: "proceeds atomically when the live check is unreachable
 * (fail-open)" is a case where `getArtistInfo` RESOLVES null. That test is
 * correct and is left completely alone - the fix does not touch that path. This
 * file covers the half it could not: a getArtistInfo that RAISES.
 *
 * Doubles are fresh plain objects per test, built here rather than shared, so
 * nothing is spied on and there is no `mockRestore` hazard.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CrownService } from '@bot/services/crown/crownService';
import { WhoKnowsArtistService } from '@bot/services/whoKnows/whoKnowsArtistService';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { CrownRepository } from '@persistence/repositories/crownRepository';
import type { UserService } from '@bot/services/user/userService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import type { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';

const LFM_DOWN = () =>
  new LastFmUnavailableError('artist.getinfo', new Error('Last.fm returned HTTP 500'));

const GUILD = { guildId: '1445761601129943222' } as never;
const NO_GUILD_USERS = new Map<number, never>();

/** A live crown held by user 1 at 100 plays, and a challenger on 150. */
const holderCrown = () => ({
  crownId: 5,
  guildId: '1445761601129943222',
  userId: 1,
  artistName: 'Mond',
  currentPlaycount: 100,
  startPlaycount: 90,
  created: new Date(),
  modified: new Date(),
  active: true,
  seededCrown: false,
  userNameLastFm: 'holder',
  discordUserId: '111',
});

const challenger = () => [
  { userId: 2, playcount: 150, lastFmUsername: 'challenger', discordName: 'Challenger', discordUserId: '222' },
];

/**
 * Constructor arity, read from `crownService.ts`:
 * (crownRepository, userService, lastfmRepository?, errorRateTracker?,
 *  abuseFilter?). `isElevated` is false so the existing global-outage kill
 * switch does not mask the site under test. The fifth argument is left
 * `undefined`, not `{}`: the filter is called as
 * `this.abuseFilter?.isFlagged(u.userId)`, which optional-chains the FILTER but
 * not the METHOD, so a bare `{}` throws a TypeError out of the eligibility
 * filter and masks the behaviour under test. `startup.ts` passes a real service;
 * undefined is the honest "not wired" case and the guard is written for it.
 */
const build = (getArtistInfo: () => Promise<unknown>, elevated = false) => {
  const replaceCrown = vi.fn(async () => ({
    ...holderCrown(),
    crownId: 6,
    userId: 2,
    currentPlaycount: 150,
    startPlaycount: 150,
  }));
  const updateCrownPlaycount = vi.fn(async () => undefined);
  const crownRepository = {
    getCurrentCrown: vi.fn(async () => holderCrown()),
    createCrown: vi.fn(async () => null),
    updateCrownPlaycount,
    replaceCrown,
  } as unknown as CrownRepository;
  const lastfmRepository = { getArtistInfo: vi.fn(getArtistInfo) } as unknown as ILastfmRepository;
  const errorRateTracker = { isElevated: vi.fn(() => elevated) } as unknown as LastfmErrorRateTracker;
  const service = new CrownService(
    crownRepository,
    {} as unknown as UserService,
    lastfmRepository,
    errorRateTracker,
    undefined,
  );
  return { service, replaceCrown, updateCrownPlaycount };
};

describe('CrownService: an unreachable Last.fm must not become a stored crown', () => {
  it('re-throws instead of writing a crown the bot could not verify', async () => {
    const { service, replaceCrown } = build(() => Promise.reject(LFM_DOWN()));
    await expect(
      service.getAndUpdateCrownForArtist(challenger() as never, NO_GUILD_USERS, GUILD, 'Mond'),
    ).rejects.toBeInstanceOf(LastFmUnavailableError);
    // The write itself is the thing under test. A test that only checked the
    // throw would pass against a version that caught, wrote, and re-threw.
    expect(replaceCrown).not.toHaveBeenCalled();
  });

  it('reports no stolen crown for an outage - the user-visible half', async () => {
    const { service } = build(() => Promise.reject(LFM_DOWN()));
    const settled = await service
      .getAndUpdateCrownForArtist(challenger() as never, NO_GUILD_USERS, GUILD, 'Mond')
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    // No `crownResult` string means no "Crown stolen by ..." announcement.
    expect(String((settled.e as Error).message)).not.toContain('Crown stolen');
  });

  it('still fails open when Last.fm ANSWERS and there is no playcount to be had', async () => {
    // The genuine empty, and the half the existing crownService.test.ts already
    // pins. `getArtistInfo` resolving null is `orUnavailable`'s not-found branch
    // - Last.fm was asked and said "nothing here". That is not an outage, and
    // the steal must still go through, exactly as before the fix.
    const { service, replaceCrown } = build(() => Promise.resolve(null));
    const res = await service.getAndUpdateCrownForArtist(
      challenger() as never,
      NO_GUILD_USERS,
      GUILD,
      'Mond',
    );
    expect(res?.stolen).toBe(true);
    expect(replaceCrown).toHaveBeenCalledTimes(1);
  });

  it('still fails open on a NON-source failure from the live recheck', async () => {
    // The other half of the pair. Narrowing to `isSourceUnavailable` must not
    // have turned an ordinary driver error into a raised one - the rest of the
    // crown logic is sound and the steal is still justified by our own index.
    const { service, replaceCrown } = build(() => Promise.reject(new Error('socket hang up')));
    const res = await service.getAndUpdateCrownForArtist(
      challenger() as never,
      NO_GUILD_USERS,
      GUILD,
      'Mond',
    );
    expect(res?.stolen).toBe(true);
    expect(replaceCrown).toHaveBeenCalledTimes(1);
  });

  it('keeps the holder when Last.fm answers that they are ahead', async () => {
    // The ordinary path, so "always throw from the live check" cannot pass.
    const { service, replaceCrown, updateCrownPlaycount } = build(() =>
      Promise.resolve({ name: 'Mond', userPlayCount: 200 }),
    );
    const res = await service.getAndUpdateCrownForArtist(
      challenger() as never,
      NO_GUILD_USERS,
      GUILD,
      'Mond',
    );
    expect(res?.stolen).toBeFalsy();
    expect(res?.crown.userId).toBe(1);
    expect(replaceCrown).not.toHaveBeenCalled();
    expect(updateCrownPlaycount).toHaveBeenCalledWith(5, 200);
  });

  it('claims a crown for a fresh artist even while Last.fm is down', async () => {
    // The claim path never reads Last.fm - it must not be collateral damage of
    // the re-throw. An empty current crown, so `replaceCrown` is never reached.
    const createCrown = vi.fn(async () => ({ ...holderCrown(), crownId: 9, userId: 2 }));
    const service = new CrownService(
      {
        getCurrentCrown: vi.fn(async () => null),
        createCrown,
        replaceCrown: vi.fn(async () => null),
        updateCrownPlaycount: vi.fn(async () => undefined),
      } as unknown as CrownRepository,
      {} as unknown as UserService,
      { getArtistInfo: vi.fn(() => Promise.reject(LFM_DOWN())) } as unknown as ILastfmRepository,
      { isElevated: vi.fn(() => false) } as unknown as LastfmErrorRateTracker,
      undefined,
    );
    const res = await service.getAndUpdateCrownForArtist(
      challenger() as never,
      NO_GUILD_USERS,
      GUILD,
      'Mond',
    );
    expect(res?.claimed).toBe(true);
    expect(createCrown).toHaveBeenCalledTimes(1);
  });

  it('reaches a boundary that renders no crown at all, rather than a wrong one', async () => {
    // The last link in the chain, and the reason the re-throw is safe.
    //
    // `CrownService.getAndUpdateCrownForArtist` has no boundary of its own. Its
    // only production caller is `WhoKnowsArtistService.getFilteredUsersForArtist`,
    // which wraps the call in `try { ... } catch { }` and leaves `crownModel` at
    // null. So the deliberate signal does not crash the who-knows command, and -
    // the point - it produces NO crown rather than a crown the bot could not
    // verify. Asserted through that real caller rather than by trusting the
    // reading, because "the throw goes somewhere sensible" is exactly the claim
    // that is easy to believe and wrong.
    //
    // Constructor arity, read from `whoKnowsArtistService.ts`:
    // (whoKnowsRepository, guildUserRepository, guildService, genreService?,
    //  crownService?).
    //
    // The Discord guild must be a real object, not null: the crown block is
    // gated on `if (this.crownService && filteredUsers.length >= 1 && guild)`,
    // and with `discordGuild = null` the guild is null, the block never runs,
    // and the whole test passes without touching CrownService at all. That is
    // the mutation this test exists to survive. Only `.id` and an empty
    // `members.cache` are read, because `getGuildUsers` returns `[]` so no
    // `FullGuildUserDetails` exists for anyone and the member lookup is skipped.
    const discordGuild = { id: '1445761601129943222', members: { cache: new Map() } } as never;
    const rows = [
      { userId: 2, playcount: 150 },
      { userId: 1, playcount: 100 },
    ];
    const crownRepository = {
      getCurrentCrown: vi.fn(async () => holderCrown()),
      createCrown: vi.fn(async () => null),
      updateCrownPlaycount: vi.fn(async () => undefined),
      replaceCrown: vi.fn(async () => ({ ...holderCrown(), crownId: 6, userId: 2 })),
    } as unknown as CrownRepository;
    const crownService = new CrownService(
      crownRepository,
      {} as unknown as UserService,
      { getArtistInfo: vi.fn(() => Promise.reject(LFM_DOWN())) } as unknown as ILastfmRepository,
      { isElevated: vi.fn(() => false) } as unknown as LastfmErrorRateTracker,
      undefined,
    );
    const whoKnows = new WhoKnowsArtistService(
      { getIndexedUsersForArtist: vi.fn(async () => rows) } as never,
      { getGuildUsers: vi.fn(async () => []) } as never,
      { getGuild: vi.fn(async () => GUILD) } as never,
      undefined,
      crownService,
    );

    const context = await whoKnows.getFilteredUsersForArtist(
      discordGuild,
      { userId: 9, userNameLastFm: 'asker' } as never,
      'Mond',
    );

    // Proof the crown path really ran, so a green test cannot be a test that
    // never called CrownService.
    expect(crownRepository.getCurrentCrown).toHaveBeenCalled();
    expect(context.crownModel).toBeNull();
    // Nobody is decorated as the crown holder - not the real one, not the
    // challenger. `hasCrown` is only ever set for a crown the call confirmed.
    expect(context.filteredUsersWithArtist.map((u) => u.hasCrown)).not.toContain(true);
    // And the permanent wrong claim was never written.
    expect(crownRepository.replaceCrown).not.toHaveBeenCalled();
  });
});
