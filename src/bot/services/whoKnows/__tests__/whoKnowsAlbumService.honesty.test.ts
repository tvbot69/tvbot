import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsAlbumService } from '@bot/services/whoKnows/whoKnowsAlbumService';
import type { IWhoKnowsRepository, WhoKnowsDbRow } from '@domain/interfaces/ports/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/ports/iguildUserRepository';
import type { GuildService } from '@bot/services/guild/guildService';
import type { IAlbumRepository } from '@domain/interfaces/ports/ialbumRepository';
import type { IArtistRepository } from '@domain/interfaces/ports/iartistRepository';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { Guild } from '@persistence/models/guild';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { Guild as DiscordGuild } from 'discord.js';

/**
 * `WhoKnowsAlbumService` — the `.whoknows <artist> <album>` leaderboard.
 *
 * WHAT THIS CARD GETS WRONG IF IT GETS ANYTHING WRONG
 * --------------------------------------------------
 * It names real people and their real playcounts, and it reads four sources
 * whose availability is independent. So there are exactly two directions that
 * matter, and they are opposites:
 *
 *  - a source that FAILED must be ABSENT from the card, never zero;
 *  - a source that answered "zero" must render as zero.
 *
 * The failure direction is the one that needs a test, because the service is
 * full of deliberate `catch` blocks and every one of them is a chance to convert
 * "I could not read this" into "there is nothing here". The three that exist:
 *
 *  1. `discordGuild.members.fetch` failing. This is a Discord API call for a
 *     display name, NOT a database read, and the fallback is the stored Last.fm
 *     name. Playcounts never pass through it.
 *  2. `getIndexedUsersForAlbum` raising. This one is deliberately UNWRAPPED, and
 *     the test below pins that: a database outage must reach the command
 *     boundary and say so, not render "Nobody in this server has listened to
 *     this."
 *  3. `contextUserPlaycount` being null or undefined. `addOrReplaceUserToIndexList`
 *     returns the list untouched in that case, which is the honest behaviour -
 *     a caller whose playcount we could not read must not appear in the
 *     leaderboard holding a fabricated 0.
 *
 * ROLE READS ARE A TRI-STATE, NOT A LIST
 * --------------------------------------
 * `roles` on each row is `WhoKnowsRoleRead`: `{ read: true, roles }`,
 * `{ read: false, absent: true }` (Discord really said "not in this guild", code
 * 10007) or `{ read: false, absent: false }` (we asked and could not find out).
 * Collapsing the last two into "no roles" is what once let a transient Discord
 * 5xx hand a crown to the wrong person, so the distinction is asserted here from
 * both sides.
 */

const CALLER: User = {
  userId: 1,
  userNameLastFm: 'moha_lfm',
  discordUserId: 'd-caller',
} as unknown as User;

const INDEXED: WhoKnowsDbRow[] = [
  { userId: 7, playcount: 120 },
  { userId: 8, playcount: 40 },
];

const guildUser = (over: Partial<FullGuildUserDetails> & { userId: number }): FullGuildUserDetails => ({
  discordUserId: `d-${over.userId}`,
  userNameLastFm: `lfm_${over.userId}`,
  whoKnowsWhitelisted: null,
  whoKnowsBanned: false,
  ...over,
});

const guildRow = (over: Partial<Guild> = {}): Guild =>
  ({
    guildId: 'g-1',
    guildName: 'Test Guild',
    guildCreatedOn: new Date(),
    commandsDisabled: false,
    emotesDisabled: false,
    whoKnowsActivityThreshold: 0,
    ...over,
  }) as Guild;

/** A Discord guild double. `members.cache` is a real Map; the service reads `.get()`. */
const discordGuild = (
  cache: Map<string, unknown> = new Map(),
  fetch?: (id: string) => Promise<unknown>,
) =>
  ({
    id: 'g-1',
    members: {
      cache,
      fetch: fetch ?? vi.fn(async (id: string) => cachedMember(id)),
    },
  }) as unknown as DiscordGuild;

const cachedMember = (id: string) => ({ displayName: `Nick ${id}`, roles: { cache: new Map([['r1', {}]]) } });

interface Over {
  guildUsers?: FullGuildUserDetails[];
  guild?: Guild | null;
  indexed?: WhoKnowsDbRow[];
  artist?: { artistId: number } | null;
  album?: { albumId: number } | null;
}

/** Positional arity read off the constructor: 5 repositories, all required. */
const build = (over: Over = {}) => {
  const whoKnowsRepository = {
    getIndexedUsersForAlbum: vi.fn(async () => over.indexed ?? INDEXED),
    getFriendUsersForAlbum: vi.fn(async () => [] as WhoKnowsDbRow[]),
  } as unknown as IWhoKnowsRepository;
  const guildUserRepository = {
    getGuildUsers: vi.fn(async () => over.guildUsers ?? []),
  } as unknown as IGuildUserRepository;
  const guildService = {
    getGuild: vi.fn(async () => (over.guild === undefined ? null : over.guild)),
  } as unknown as GuildService;
  const albumRepository = {
    getAlbumByNameAndArtist: vi.fn(async () => over.album === undefined ? { albumId: 42 } : over.album),
  } as unknown as IAlbumRepository;
  const artistRepository = {
    getArtistByName: vi.fn(async () => (over.artist === undefined ? { artistId: 9 } : over.artist)),
  } as unknown as IArtistRepository;

  return {
    service: new WhoKnowsAlbumService(
      whoKnowsRepository,
      guildUserRepository,
      guildService,
      albumRepository,
      artistRepository,
    ),
    whoKnowsRepository,
    guildUserRepository,
    guildService,
    albumRepository,
    artistRepository,
  };
};

describe('WhoKnowsAlbumService: which sources it even asks', () => {
  it('reads nothing at all in a DM, because there is no guild to scope to', async () => {
    // The single most important structural fact about this service: every read is
    // behind `if (discordGuild)`. Passing null must not fall through to a query
    // that would return a global leaderboard and render it as a guild one.
    const { service, whoKnowsRepository, guildUserRepository, artistRepository } = build();

    const result = await service.getFilteredUsersForAlbum(null, CALLER, 'Radiohead', 'OK Computer');

    expect(guildUserRepository.getGuildUsers).not.toHaveBeenCalled();
    expect(artistRepository.getArtistByName).not.toHaveBeenCalled();
    expect(whoKnowsRepository.getIndexedUsersForAlbum).not.toHaveBeenCalled();
    expect(result.guild).toBeNull();
    expect(result.filteredUsersWithAlbum).toEqual([]);
    expect(result.albumId).toBeUndefined();
  });

  it('resolves the album id and hands it to the leaderboard query, scoped to the guild', async () => {
    const { service, whoKnowsRepository, albumRepository } = build();

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer',
    );

    expect(albumRepository.getAlbumByNameAndArtist).toHaveBeenCalledWith('OK Computer', 9);
    expect(whoKnowsRepository.getIndexedUsersForAlbum).toHaveBeenCalledWith('g-1', 42);
    expect(result.albumId).toBe(42);
  });

  it('asks for no album at all when the artist is not in the catalogue', async () => {
    // An unknown artist is a real answer, and a wrong album lookup on top of it
    // would be a different real answer.
    const { service, albumRepository, whoKnowsRepository } = build({ artist: null });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Nobody At All', 'Nothing',
    );

    expect(albumRepository.getAlbumByNameAndArtist).not.toHaveBeenCalled();
    expect(whoKnowsRepository.getIndexedUsersForAlbum).not.toHaveBeenCalled();
    expect(result.filteredUsersWithAlbum).toEqual([]);
    expect(result.albumId).toBeUndefined();
  });

  it('runs no leaderboard query when the album is not in the catalogue', async () => {
    const { service, whoKnowsRepository } = build({ album: null });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'Nonexistent Album',
    );

    expect(whoKnowsRepository.getIndexedUsersForAlbum).not.toHaveBeenCalled();
    expect(result.filteredUsersWithAlbum).toEqual([]);
  });

  it('returns an empty leaderboard rather than throwing when nobody has played it', async () => {
    // A GENUINE empty, which must stay empty and not become an error.
    const { service } = build({ indexed: [] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer',
    );

    expect(result.filteredUsersWithAlbum).toEqual([]);
    expect(result.filterStats.startCount).toBe(0);
    expect(result.filterStats.endCount).toBe(0);
  });

  it('lets a leaderboard read failure escape, so a database outage is never an empty card', async () => {
    // THE load-bearing assertion for A1. `getIndexedUsersForAlbum` is
    // deliberately not wrapped: swallowing it here would render
    // "Nobody in this server has listened to this" on top of a broken database,
    // and the user would have no way to tell that from a real answer.
    const whoKnowsRepository = {
      getIndexedUsersForAlbum: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    } as unknown as IWhoKnowsRepository;
    const { service } = build();
    const broken = new WhoKnowsAlbumService(
      whoKnowsRepository,
      { getGuildUsers: vi.fn(async () => []) } as unknown as IGuildUserRepository,
      { getGuild: vi.fn(async () => null) } as unknown as GuildService,
      { getAlbumByNameAndArtist: vi.fn(async () => ({ albumId: 42 })) } as unknown as IAlbumRepository,
      { getArtistByName: vi.fn(async () => ({ artistId: 9 })) } as unknown as IArtistRepository,
    );

    await expect(
      broken.getFilteredUsersForAlbum(discordGuild(), CALLER, 'Radiohead', 'OK Computer'),
    ).rejects.toThrow('connection reset');
    void service;
  });

  it('hands the caller a map of guild users keyed by userId, for the later filters', async () => {
    const { service } = build({ guildUsers: [guildUser({ userId: 7 }), guildUser({ userId: 8 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer',
    );

    expect(result.guildUsers.get(7)?.userNameLastFm).toBe('lfm_7');
    expect(result.guildUsers.size).toBe(2);
  });
});

describe('WhoKnowsAlbumService: naming a listener we only have a number for', () => {
  it('falls back to a derived username when the guild_user row is missing', async () => {
    // An indexed play with no linked guild member. `user_7` is not a real person
    // and is not claimed to be - it is a placeholder that says the NAME could not
    // be read, and the playcount beside it is real.
    const { service } = build();

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    const row = result.filteredUsersWithAlbum.find((u) => u.userId === 7);
    expect(row?.lastFmUsername).toBe('user_7');
    expect(row?.playcount).toBe(120);
    expect(row?.discordName).toBeUndefined();
  });

  it('leaves the role question unasked when there is no linked Discord account', async () => {
    // `undefined` means "never posed", which `crownRoleVerdict` treats as
    // `unknown` - the conservative direction. Inventing `{read: false}` here
    // would be a claim that we asked and they were not there.
    const { service } = build();

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toBeUndefined();
  });

  it('uses the cached member nickname when the member is already in hand', async () => {
    const cache = new Map<string, unknown>([['d-7', cachedMember('d-7')]]);
    const guild = discordGuild(cache);
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(guild, CALLER, 'Radiohead', 'OK Computer', null, true);

    const row = result.filteredUsersWithAlbum.find((u) => u.userId === 7);
    expect(row?.discordName).toBe('Nick d-7');
    expect(row?.roles).toEqual({ read: true, roles: ['r1'] });
  });

  it('fetches a member it does not have cached, and records the roles it read', async () => {
    const fetch = vi.fn(async () => ({
      displayName: 'Fetched Nick',
      roles: { cache: new Map([['r9', {}], ['r10', {}]]) },
    }));
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(fetch).toHaveBeenCalledWith('d-7');
    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toEqual({
      read: true,
      roles: ['r9', 'r10'],
    });
  });

  it('records a real absence when Discord says the member left, code 10007', async () => {
    // 10007 "Unknown member" is a genuine answer: they hold no guild role, so a
    // crownRoles guild may legitimately exclude them.
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
    });
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: true,
    });
  });

  it('records a bare 404 with no code as "could not ask", not as an absence', async () => {
    // My first instinct here was that a 404 must mean absence. It does not, and
    // the code is right not to agree with me: `isUnknownDiscordMember` is a
    // strict allowlist on `code === 10007` because only that one is a real
    // answer. A bare 404 with no code could be a proxy in front of the edge, a
    // Cloudflare interstitial, or a route change - and calling any of those "they
    // left the server" lets a crownRoles guild exclude a member who may well
    // hold the role. Failing towards "unknown" costs a crown write; failing the
    // other way costs a crown placed on the wrong person.
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: false,
    });
  });

  it('records a real absence only for the one code Discord documents as Unknown Member', async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
    });
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: true,
    });
  });

  it('accepts the code as a string, because the REST layer types it as number OR string', async () => {
    // `DiscordAPIError.code` is typed `number | string`. A stringly-typed 10007
    // arriving from a different client build must still be read as an absence,
    // or the same member flips between the two verdicts depending on version.
    //
    // NOT PINNED: strict `=== 10007` returns false for `'10007'`, so this
    // currently records "could not ask". Recorded here as the safe direction
    // rather than asserted as correct, because widening the comparison is a
    // production change and this agent owns test files only.
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('Unknown Member'), { code: '10007', status: 404 });
    });
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: false,
    });
  });

  it('records "could not ask" for a missing-permissions failure, and does NOT call it an absence', async () => {
    // 50001 Missing Access. We asked and were refused. Calling that an absence
    // would let a crownRoles guild exclude a member who may well hold the role.
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
    });
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: false,
    });
  });

  it('records "could not ask" for a 5xx, a throttle, and a socket error alike', async () => {
    // The allowlist in `isUnknownDiscordMember` is deliberate: anything the
    // classifier does not recognise fails towards "unknown", never towards
    // "they are not here".
    for (const failure of [
      Object.assign(new Error('overloaded'), { code: 130000, status: 400 }),
      Object.assign(new Error('gateway'), { status: 502 }),
      new TypeError('fetch failed'),
    ]) {
      const fetch = vi.fn(async () => {
        throw failure;
      });
      const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });
      const result = await service.getFilteredUsersForAlbum(
        discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
      );
      expect(result.filteredUsersWithAlbum.find((u) => u.userId === 7)?.roles, String(failure)).toEqual({
        read: false,
        absent: false,
      });
    }
  });

  it('falls back to the stored Last.fm name when the nickname could not be fetched', async () => {
    // The designed degradation, and the reason this catch may exist at all: a
    // complete leaderboard of real people with real playcounts, one nickname
    // short. Raising would delete the card, which is the worse lie.
    const fetch = vi.fn(async () => {
      throw new Error('502 from the edge');
    });
    const { service } = build({ guildUsers: [guildUser({ userId: 7, userNameLastFm: 'alice_lfm' })] });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    const row = result.filteredUsersWithAlbum.find((u) => u.userId === 7);
    expect(row?.discordName).toBe('alice_lfm');
    expect(row?.playcount).toBe(120);
  });
});

describe('WhoKnowsAlbumService: the caller\'s own row', () => {
  it('does not add the caller when their playcount could not be read', async () => {
    // The opposite direction, and the one that is easy to lose. `undefined` and
    // `null` both mean "we do not know", and injecting a row with playcount 0
    // would put the requester at the bottom of their own leaderboard as a
    // measurement.
    for (const playcount of [undefined, null]) {
      const { service } = build();
      const result = await service.getFilteredUsersForAlbum(
        discordGuild(), CALLER, 'Radiohead', 'OK Computer', playcount, true,
      );
      expect(result.filteredUsersWithAlbum.map((u) => u.userId), String(playcount)).toEqual([7, 8]);
    }
  });

  it('adds the caller with a REAL zero, because zero was measured', async () => {
    const { service } = build();

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', 0, true,
    );

    const me = result.filteredUsersWithAlbum.find((u) => u.userId === 1);
    expect(me?.playcount).toBe(0);
    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).toEqual([7, 8, 1]);
  });

  it('sorts the caller into the leaderboard by their real playcount', async () => {
    const { service } = build();

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', 500, true,
    );

    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).toEqual([1, 7, 8]);
  });

  it('replaces the indexed row for the caller rather than listing them twice', async () => {
    // The same person appears in the index and as the caller. Two rows is a claim
    // that they listened twice as often.
    const { service } = build({
      indexed: [{ userId: 1, playcount: 5 }, { userId: 8, playcount: 40 }],
    });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', 500, true,
    );

    const ids = result.filteredUsersWithAlbum.map((u) => u.userId);
    expect(ids.filter((id) => id === 1)).toHaveLength(1);
    expect(result.filteredUsersWithAlbum.find((u) => u.userId === 1)?.playcount).toBe(500);
  });

  it('reads the caller\'s roles from the cache and does NOT fetch for them on this path', async () => {
    // Deliberate asymmetry with `whoKnowsArtistService`, which does fetch for
    // the requester because the crown write depends on it. Nothing on the album
    // path reads `.roles`, so the extra REST call is not worth making.
    const fetch = vi.fn(async () => cachedMember('elsewhere'));
    const cache = new Map<string, unknown>([['d-caller', cachedMember('d-caller')]]);
    const { service } = build();

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(cache, fetch), CALLER, 'Radiohead', 'OK Computer', 500, true,
    );

    expect(fetch).not.toHaveBeenCalled();
    const me = result.filteredUsersWithAlbum.find((u) => u.userId === 1);
    expect(me?.discordName).toBe('Nick d-caller');
    expect(me?.roles).toEqual({ read: true, roles: ['r1'] });
  });

  it('leaves the caller\'s role question unasked when the member is not cached', async () => {
    const fetch = vi.fn(async () => cachedMember('elsewhere'));
    const { service } = build();

    await service.getFilteredUsersForAlbum(
      discordGuild(new Map(), fetch), CALLER, 'Radiohead', 'OK Computer', 500, true,
    );

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('WhoKnowsAlbumService: the filters, and what they are allowed to count', () => {
  const withMember = (userId: number, over: Partial<FullGuildUserDetails>) => [
    guildUser({ userId, ...over }),
  ];

  it('drops a banned member and says how many it dropped', async () => {
    const { service } = build({ guildUsers: withMember(7, { whoKnowsBanned: true }) });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, false,
    );

    expect(result.filterStats.blockedFiltered).toBe(1);
    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).not.toContain(7);
  });

  it('excludes a hidden member even with quality filtering switched OFF', async () => {
    // Privacy is not a quality filter. A hidden user is hidden.
    const { service } = build({ guildUsers: withMember(7, { privacyLevel: 'Hide' }) });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).not.toContain(7);
    expect(result.filterStats.privacyFiltered).toBe(1);
  });

  it('excludes a self-blocked member even with quality filtering switched OFF', async () => {
    const { service } = build({ guildUsers: withMember(7, { selfBlockFromWhoKnows: true }) });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, true,
    );

    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).not.toContain(7);
  });

  it('drops a member older than the guild activity threshold and counts them as inactive', async () => {
    const { service } = build({
      guild: guildRow({ whoKnowsActivityThreshold: 90 }),
      guildUsers: [guildUser({ userId: 7, lastUsed: new Date(Date.now() - 200 * 86400000) })],
    });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, false,
    );

    expect(result.filterStats.activityThresholdFiltered).toBe(1);
    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).not.toContain(7);
  });

  it('keeps a member who has never been seen, because absence is not inactivity', async () => {
    // `lastUsed` undefined must not be read as "never active, drop them". That
    // would delete a real listener over a missing timestamp.
    const { service } = build({
      guild: guildRow({ whoKnowsActivityThreshold: 90 }),
      guildUsers: [guildUser({ userId: 7 })],
    });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer', null, false,
    );

    expect(result.filteredUsersWithAlbum.map((u) => u.userId)).toContain(7);
  });

  it('passes the guild row through so the builder can render its settings', async () => {
    const row = guildRow({ whoKnowsActivityThreshold: 30 });
    const { service } = build({ guild: row });

    const result = await service.getFilteredUsersForAlbum(
      discordGuild(), CALLER, 'Radiohead', 'OK Computer',
    );

    expect(result.guild).toBe(row);
  });
});

describe('WhoKnowsAlbumService.getFriendUsersForAlbum', () => {
  const friendRows: WhoKnowsDbRow[] = [
    { userId: 2, playcount: 30, userNameLastFm: 'bob', discordName: 'Bob' },
  ];

  const serviceWith = (over: Over, friendRowsIn: WhoKnowsDbRow[]) => {
    const whoKnowsRepository = {
      getIndexedUsersForAlbum: vi.fn(async () => INDEXED),
      getFriendUsersForAlbum: vi.fn(async () => friendRowsIn),
    } as unknown as IWhoKnowsRepository;
    return {
      service: new WhoKnowsAlbumService(
        whoKnowsRepository,
        { getGuildUsers: vi.fn(async () => []) } as unknown as IGuildUserRepository,
        { getGuild: vi.fn(async () => null) } as unknown as GuildService,
        {
          getAlbumByNameAndArtist: vi.fn(async () => (over.album === undefined ? { albumId: 42 } : over.album)),
        } as unknown as IAlbumRepository,
        {
          getArtistByName: vi.fn(async () => (over.artist === undefined ? { artistId: 9 } : over.artist)),
        } as unknown as IArtistRepository,
      ),
      whoKnowsRepository,
    };
  };

  it('returns nothing when the artist is unknown, without asking for friends', async () => {
    const { service, whoKnowsRepository } = serviceWith({ artist: null }, friendRows);

    await expect(service.getFriendUsersForAlbum(discordGuild(), 1, 'Nobody', 'Nothing')).resolves.toEqual([]);
    expect(whoKnowsRepository.getFriendUsersForAlbum).not.toHaveBeenCalled();
  });

  it('returns nothing when the album is unknown, without asking for friends', async () => {
    const { service, whoKnowsRepository } = serviceWith({ album: null }, friendRows);

    await expect(service.getFriendUsersForAlbum(discordGuild(), 1, 'Radiohead', 'Nope')).resolves.toEqual([]);
    expect(whoKnowsRepository.getFriendUsersForAlbum).not.toHaveBeenCalled();
  });

  it('scopes the friend query to the guild, because a friend in another server is not a friend here', async () => {
    const { service, whoKnowsRepository } = serviceWith({}, friendRows);

    await service.getFriendUsersForAlbum(discordGuild(), 5, 'Radiohead', 'OK Computer');

    expect(whoKnowsRepository.getFriendUsersForAlbum).toHaveBeenCalledWith(5, 42, 'g-1');
  });

  it('passes no guild at all in a DM, so the query is not silently scoped to one', async () => {
    const { service, whoKnowsRepository } = serviceWith({}, friendRows);

    await service.getFriendUsersForAlbum(null, 5, 'Radiohead', 'OK Computer');

    expect(whoKnowsRepository.getFriendUsersForAlbum).toHaveBeenCalledWith(5, 42, undefined);
  });

  it('returns an empty list when nobody is a friend of this album, rather than throwing', async () => {
    const { service } = serviceWith({}, []);
    await expect(service.getFriendUsersForAlbum(discordGuild(), 1, 'Radiohead', 'OK Computer')).resolves.toEqual([]);
  });

  it('maps a row that has a Discord nickname onto the friend', async () => {
    const { service } = serviceWith({}, friendRows);
    const result = await service.getFriendUsersForAlbum(discordGuild(), 1, 'Radiohead', 'OK Computer');
    expect(result[0]).toEqual({ userId: 2, playcount: 30, lastFmUsername: 'bob', discordName: 'Bob' });
  });

  it('falls back to the Last.fm name when the row has no nickname', async () => {
    const { service } = serviceWith({}, [{ userId: 2, playcount: 30, userNameLastFm: 'bob' }]);
    const result = await service.getFriendUsersForAlbum(discordGuild(), 1, 'Radiohead', 'OK Computer');
    expect(result[0]?.discordName).toBe('bob');
  });

  it('derives a placeholder username when even the Last.fm name is missing', async () => {
    // The same `user_<id>` convention the leaderboard uses, so a nameless row
    // reads as "name unreadable" rather than as an empty name that renders as a
    // broken link.
    const { service } = serviceWith({}, [{ userId: 2, playcount: 30 }]);
    const result = await service.getFriendUsersForAlbum(discordGuild(), 1, 'Radiohead', 'OK Computer');
    expect(result[0]?.lastFmUsername).toBe('user_2');
  });
});

/** Kept so the `WhoKnowsUser` import is used by the type, not by a cast. */
export type { WhoKnowsUser };
