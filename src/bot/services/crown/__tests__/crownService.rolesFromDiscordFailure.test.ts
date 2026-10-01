/**
 * The whole Task A chain, end to end, through the two real services:
 *
 *   `discordGuild.members.fetch` rejects
 *     -> `WhoKnowsArtistService` records WHICH kind of failure it was
 *     -> `CrownService` decides whether that may name a crown holder
 *
 * The unit test next door (`crownService.unreadRoles.test.ts`) hand-builds the
 * role states. That is the right way to pin the decision, but it cannot prove
 * the producer builds those states - and the producer is where the bug lived:
 * a bare `catch {}` left `roles` `undefined` for a 5xx and for a member who
 * left the server alike. A decision-only test would stay green against a
 * producer that never distinguishes anything.
 *
 * So this file drives the real `members.fetch` rejection. The errors are real
 * `DiscordAPIError` instances built the way `@discordjs/rest` builds them, not
 * `{ code: 10007 }` literals, so the test fails if the predicate ever has to
 * guess at the shape.
 *
 * The pair is the same two people, the same playcounts, and the same guild; only
 * the leader's Discord response differs. 10007 must still crown the person
 * below (they really did leave, and that exclusion is justified). 130000 and
 * 50001 must write nothing at all.
 *
 * `reflect-metadata` first: both services are `tsyringe` classes.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import { WhoKnowsArtistService } from '@bot/services/whoKnows/whoKnowsArtistService';
import { CrownService } from '@bot/services/crown/crownService';
import type { CrownRepository } from '@persistence/repositories/crownRepository';
import type { UserService } from '@bot/services/user/userService';
import type { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { IGuildUserRepository } from '@domain/interfaces/iguildUserRepository';
import type { GuildService } from '@bot/services/guild/guildService';
import type { User } from '@domain/interfaces/iuserRepository';

const GUILD_ID = '1445761601129943222';
const CROWN_ROLE = '555';
const MEMBER_URL = 'https://discord.com/api/v10/guilds/1445761601129943222/members/111';

const apiError = (code: number, status: number, message: string): DiscordAPIError =>
  new DiscordAPIError({ code, message }, code, status, 'GET', MEMBER_URL, { files: undefined });

/** What `GET /guilds/{g}/members/{u}` answers for a user who is not in the guild. */
const UNKNOWN_MEMBER = () => apiError(10007, 404, 'Unknown Member');
/** Documented as "Try again a little later" - the retryable direction. */
const API_OVERLOADED = () =>
  apiError(130000, 503, 'API resource is currently overloaded. Try again a little later');
/** 50001, NOT 50014. A bot that cannot see the guild is not a user who left. */
const MISSING_ACCESS = () => apiError(50001, 403, 'Missing Access');

const GUILD_ROW = { guildId: GUILD_ID, crownRoles: [CROWN_ROLE] } as never;

/** The leader is 50 plays ahead of the runner-up. The whole bug is that gap. */
const INDEXED_ROWS = [
  { userId: 1, playcount: 200 },
  { userId: 2, playcount: 150 },
];

const GUILD_USERS = [
  { userId: 1, discordUserId: '111', userNameLastFm: 'leader' },
  { userId: 2, discordUserId: '222', userNameLastFm: 'runner' },
];

/**
 * The requester, given no `discordUserId`. That keeps the requester fetch
 * branch in `getFilteredUsersForArtist` out of the picture, so this file is only
 * about the two listeners. `contextUserPlaycount` is `null` below, so the
 * requester is not injected into the index list either way.
 */
const CONTEXT_USER = { userId: 9, userNameLastFm: 'asker' } as unknown as User;

/**
 * A `GuildMember` double. Only `displayName` and `roles.cache.keys()` are read
 * off it - enumerated from `whoKnowsArtistService.ts`, which touches nothing
 * else on a member it gets back from `members.fetch`.
 */
const member = (name: string, roleIds: string[]) => ({
  displayName: name,
  roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
});

/**
 * `members.fetch` is routed by id: '111' is the leader and its behaviour is the
 * variable; '222' always resolves and holds the crown role.
 *
 * `members.cache` is an empty Map on purpose. The service only calls `fetch`
 * when the cache misses, so a populated cache would mean `fetch` was never
 * reached and every assertion below would pass without exercising anything.
 */
const build = (leaderFetch: () => Promise<unknown>) => {
  const fetch = vi.fn(async (userId: string) => {
    if (userId === '111') return leaderFetch();
    return member('Runner', [CROWN_ROLE]);
  });
  const discordGuild = { id: GUILD_ID, members: { cache: new Map(), fetch } } as never;

  const createCrown = vi.fn(async (data: Record<string, unknown>) => ({
    crownId: 9,
    guildId: GUILD_ID,
    artistName: 'Mond',
    currentPlaycount: data.playcount,
    startPlaycount: data.playcount,
    created: new Date(),
    modified: new Date(),
    active: true,
    seededCrown: false,
    userNameLastFm: 'unknown',
    discordUserId: 'unknown',
    ...data,
  }));
  const replaceCrown = vi.fn(async () => null);
  const updateCrownPlaycount = vi.fn(async () => undefined);
  const crownRepository = {
    getCurrentCrown: vi.fn(async () => null),
    createCrown,
    replaceCrown,
    updateCrownPlaycount,
  } as unknown as CrownRepository;

  // Arity read off `crownService.ts`: (crownRepository, userService,
  // lastfmRepository?, errorRateTracker?, abuseFilter?). `lastfmRepository` is
  // undefined so `getHolderLivePlaycount` returns null at once and the Last.fm
  // recheck is not a second site under test; `abuseFilter` is undefined rather
  // than `{}` because the eligibility filter calls
  // `this.abuseFilter?.isFlagged(...)`, which optional-chains the filter but not
  // the method.
  const crownService = new CrownService(
    crownRepository,
    {} as unknown as UserService,
    undefined,
    { isElevated: vi.fn(() => false) } as unknown as LastfmErrorRateTracker,
    undefined,
  );

  // Arity read off `WhoKnowsArtistService`'s constructor: (whoKnowsRepository,
  // guildUserRepository, guildService, genreService?, crownService?).
  const whoKnows = new WhoKnowsArtistService(
    { getIndexedUsersForArtist: vi.fn(async () => INDEXED_ROWS) } as unknown as IWhoKnowsRepository,
    { getGuildUsers: vi.fn(async () => GUILD_USERS) } as unknown as IGuildUserRepository,
    { getGuild: vi.fn(async () => GUILD_ROW) } as unknown as GuildService,
    undefined,
    crownService,
  );

  return { whoKnows, discordGuild, createCrown, replaceCrown, updateCrownPlaycount, fetch };
};

const run = async (leaderFetch: () => Promise<unknown>) => {
  const bundle = build(leaderFetch);
  const context = await bundle.whoKnows.getFilteredUsersForArtist(
    bundle.discordGuild,
    CONTEXT_USER,
    'Mond',
  );
  return { ...bundle, context };
};

const row = (context: Awaited<ReturnType<typeof run>>['context'], userId: number) =>
  context.filteredUsersWithArtist.find((u) => u.userId === userId);

describe('a member-fetch failure reaching the crown store', () => {
  it('writes no crown when the leader\u2019s roles could not be read', async () => {
    // The failure half, driven from the real fetch rejection. 130000 is
    // documented as retryable, so it is unambiguously "I could not ask" and not
    // an answer about the member.
    const { context, createCrown, replaceCrown, updateCrownPlaycount, fetch } = await run(() => {
      throw API_OVERLOADED();
    });

    // Proof the whole chain really ran: the fetch was attempted for the leader
    // and the leaderboard came back intact, so a green "no wrong crown" cannot
    // come from the crown block never executing or the users vanishing.
    expect(fetch).toHaveBeenCalledWith('111');
    expect(fetch).toHaveBeenCalledWith('222');
    // `filterWhoKnowsObjects` does not sort - the builder does - so this is the
    // order `getIndexedUsersForArtist` returned, in playcount order. Numeric
    // sort on userId so the assertion cannot pass on a lexicographic accident.
    expect(context.filteredUsersWithArtist.map((u) => u.userId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(context.filteredUsersWithArtist.map((u) => u.playcount)).toEqual([200, 150]);

    expect(createCrown).not.toHaveBeenCalled();
    expect(replaceCrown).not.toHaveBeenCalled();
    expect(updateCrownPlaycount).not.toHaveBeenCalled();
    // Nobody is decorated as the holder - not the real one, not the runner-up.
    expect(context.filteredUsersWithArtist.map((u) => u.hasCrown)).not.toContain(true);
    expect(context.crownModel).toBeNull();
  });

  it('still crowns the runner-up when the leader genuinely left the server', async () => {
    // The PAIR. Discord answered 10007 for the leader, so excluding them is
    // justified and the runner-up taking the crown is correct. If the fix had
    // been "block on any failure", this would fail - and it must not, or crowns
    // would freeze in every guild where anyone ever leaves.
    const { context, createCrown } = await run(() => {
      throw UNKNOWN_MEMBER();
    });

    expect(createCrown).toHaveBeenCalledTimes(1);
    expect(createCrown.mock.calls[0]![0]).toMatchObject({ userId: 2, currentPlaycount: 150 });
    expect(context.crownModel?.crown.userId).toBe(2);
    expect(context.crownModel?.claimed).toBe(true);
  });

  it('writes no crown on 50001 Missing Access either', async () => {
    // The number the hand-off note got wrong (it guessed 50014, which is
    // "Invalid authentication token provided"). Either way it is a bot that
    // cannot see, so it must not be read as a member who left.
    const { context, createCrown } = await run(() => {
      throw MISSING_ACCESS();
    });

    expect(createCrown).not.toHaveBeenCalled();
    expect(context.crownModel).toBeNull();
  });

  it('keeps the leaderboard, the display names and the playcounts through a fetch failure', async () => {
    // The degradation that is NOT a lie, pinned so the fix cannot have bought
    // its safety by raising. A failed fetch falls back to the stored Last.fm
    // name, which is a real name, and the rows and playcounts come from
    // `getIndexedUsersForArtist`, which is deliberately unwrapped.
    const { context } = await run(() => {
      throw API_OVERLOADED();
    });

    expect(context.filteredUsersWithArtist).toHaveLength(2);
    // The leader's nickname could not be fetched, so the card shows the real
    // stored Last.fm name - not a blank, and not a fabricated nickname.
    expect(row(context, 1)?.discordName).toBe('leader');
    // The runner-up was fetched fine and keeps their real nickname.
    expect(row(context, 2)?.discordName).toBe('Runner');
  });

  it('crowns the leader when their fetch succeeds and they hold the role', async () => {
    // The ordinary path, so "block whenever anything goes wrong" cannot pass.
    const { context, createCrown } = await run(async () => member('Leader', [CROWN_ROLE]));

    expect(createCrown).toHaveBeenCalledTimes(1);
    expect(createCrown.mock.calls[0]![0]).toMatchObject({ userId: 1, currentPlaycount: 200 });
    expect(context.crownModel?.crown.userId).toBe(1);
  });
});
