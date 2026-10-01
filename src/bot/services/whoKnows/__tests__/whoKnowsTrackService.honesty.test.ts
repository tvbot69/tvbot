import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsTrackService } from '@bot/services/whoKnows/whoKnowsTrackService';
import type { IWhoKnowsRepository, WhoKnowsDbRow } from '@domain/interfaces/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { GuildService } from '@bot/services/guild/guildService';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import type { Guild } from '@persistence/models/guild';
import type { Guild as DiscordGuild } from 'discord.js';

/**
 * `WhoKnowsTrackService` — the `.whoknows <artist> <track>` leaderboard.
 *
 * This file is deliberately NOT a copy of `whoKnowsAlbumService.honesty.test.ts`
 * with the words swapped. The two services are line-for-line parallel - same
 * constructor arity, same member-name resolution, same role tri-state, same
 * filters - so re-asserting all of that here would be thirty tests that pass for
 * the wrong reason and cost nothing to maintain and everything to review.
 *
 * So this file pins ONLY the two things that differ, plus the two places where
 * "the album version happens to have it right" is not the same guarantee:
 *
 *  1. The track id comes from `getTrackByNameAndArtist(trackName, artistId)`,
 *     which takes the TRACK name first. A swapped pair resolves a different
 *     recording, so the argument order is asserted explicitly.
 *  2. The result key is `filteredUsersWithTrack`, not `...WithAlbum`, and the
 *     album version's `albumId` has no counterpart here - so a consumer that
 *     destructures one and not the other is the risk.
 *
 * Everything else about the album path - the DM short-circuit, the unwrapped
 * index read, the `user_<id>` fallback, the three-way role read, the privacy
 * rules, the null-playcount caller - is covered there and behaves identically
 * because the two files share a shape that was written once.
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

const cachedMember = (id: string) => ({
  displayName: `Nick ${id}`,
  roles: { cache: new Map([['r1', {}]]) },
});

const discordGuild = (cache: Map<string, unknown> = new Map(), fetch?: (id: string) => Promise<unknown>) =>
  ({
    id: 'g-1',
    members: { cache, fetch: fetch ?? vi.fn(async (id: string) => cachedMember(id)) },
  }) as unknown as DiscordGuild;

interface Over {
  guildUsers?: FullGuildUserDetails[];
  guild?: Guild | null;
  indexed?: WhoKnowsDbRow[];
  artist?: { artistId: number } | null;
  track?: { trackId: number } | null;
}

/** Positional arity read off the constructor: 5 repositories, all required. */
const build = (over: Over = {}) => {
  const whoKnowsRepository = {
    getIndexedUsersForTrack: vi.fn(async () => over.indexed ?? INDEXED),
    getFriendUsersForTrack: vi.fn(async () => [] as WhoKnowsDbRow[]),
  } as unknown as IWhoKnowsRepository;
  const guildUserRepository = {
    getGuildUsers: vi.fn(async () => over.guildUsers ?? []),
  } as unknown as IGuildUserRepository;
  const guildService = {
    getGuild: vi.fn(async () => (over.guild === undefined ? null : over.guild)),
  } as unknown as GuildService;
  const trackRepository = {
    getTrackByNameAndArtist: vi.fn(async () => (over.track === undefined ? { trackId: 77 } : over.track)),
  } as unknown as ITrackRepository;
  const artistRepository = {
    getArtistByName: vi.fn(async () => (over.artist === undefined ? { artistId: 9 } : over.artist)),
  } as unknown as IArtistRepository;

  return {
    service: new WhoKnowsTrackService(
      whoKnowsRepository,
      guildUserRepository,
      guildService,
      trackRepository,
      artistRepository,
    ),
    whoKnowsRepository,
    guildUserRepository,
    trackRepository,
    artistRepository,
  };
};

describe('WhoKnowsTrackService: resolving the track before the leaderboard', () => {
  it('looks the track up by TRACK name against the ARTIST id, in that order', async () => {
    // The album twin is `getAlbumByNameAndArtist(albumName, artistId)`; the
    // argument order is the same but the NAME is a different field, and swapping
    // them silently resolves a different recording entirely.
    const { service, trackRepository, artistRepository } = build();

    await service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Radiohead', 'Creep');

    expect(artistRepository.getArtistByName).toHaveBeenCalledWith('Radiohead');
    expect(trackRepository.getTrackByNameAndArtist).toHaveBeenCalledWith('Creep', 9);
  });

  it('scopes the leaderboard query to the guild and the resolved track id', async () => {
    const { service, whoKnowsRepository } = build();

    await service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Radiohead', 'Creep');

    expect(whoKnowsRepository.getIndexedUsersForTrack).toHaveBeenCalledWith('g-1', 77);
  });

  it('returns no album id at all, because a track has no album identity here', async () => {
    const { service } = build();

    const result = await service.getFilteredUsersForTrack(
      discordGuild(), CALLER, 'Radiohead', 'Creep',
    );

    // The album twin carries `albumId: number | undefined`. Its absence here is
    // what stops a caller from reading an undefined as an id.
    expect(Object.keys(result)).not.toContain('albumId');
  });

  it('keys the leaderboard as a TRACK, not as an album', async () => {
    const { service } = build();

    const result = await service.getFilteredUsersForTrack(
      discordGuild(), CALLER, 'Radiohead', 'Creep',
    );

    expect(Object.keys(result)).toContain('filteredUsersWithTrack');
    expect(Object.keys(result)).not.toContain('filteredUsersWithAlbum');
    expect(result.filteredUsersWithTrack.map((u) => u.playcount)).toEqual([120, 40]);
  });

  it('reads nothing in a DM, for the same reason the album path does not', async () => {
    const { service, whoKnowsRepository, artistRepository } = build();

    const result = await service.getFilteredUsersForTrack(null, CALLER, 'Radiohead', 'Creep');

    expect(artistRepository.getArtistByName).not.toHaveBeenCalled();
    expect(whoKnowsRepository.getIndexedUsersForTrack).not.toHaveBeenCalled();
    expect(result.guild).toBeNull();
    expect(result.filteredUsersWithTrack).toEqual([]);
  });

  it('runs no leaderboard query when the artist or the track is unknown', async () => {
    const noArtist = build({ artist: null });
    await expect(
      noArtist.service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Nobody', 'Nothing'),
    ).resolves.toMatchObject({ filteredUsersWithTrack: [] });
    expect(noArtist.whoKnowsRepository.getIndexedUsersForTrack).not.toHaveBeenCalled();

    const noTrack = build({ track: null });
    await expect(
      noTrack.service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Radiohead', 'Nope'),
    ).resolves.toMatchObject({ filteredUsersWithTrack: [] });
    expect(noTrack.whoKnowsRepository.getIndexedUsersForTrack).not.toHaveBeenCalled();
  });

  it('lets a leaderboard read failure escape rather than rendering an empty card', async () => {
    const whoKnowsRepository = {
      getIndexedUsersForTrack: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    } as unknown as IWhoKnowsRepository;
    const service = new WhoKnowsTrackService(
      whoKnowsRepository,
      { getGuildUsers: vi.fn(async () => []) } as unknown as IGuildUserRepository,
      { getGuild: vi.fn(async () => null) } as unknown as GuildService,
      { getTrackByNameAndArtist: vi.fn(async () => ({ trackId: 77 })) } as unknown as ITrackRepository,
      { getArtistByName: vi.fn(async () => ({ artistId: 9 })) } as unknown as IArtistRepository,
    );

    await expect(
      service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Radiohead', 'Creep'),
    ).rejects.toThrow('connection reset');
  });
});

describe('WhoKnowsTrackService: the parts that are the same and must stay the same', () => {
  it('derives a placeholder username for a row with no guild_user link', async () => {
    const { service } = build();

    const result = await service.getFilteredUsersForTrack(
      discordGuild(), CALLER, 'Radiohead', 'Creep', null, true,
    );

    expect(result.filteredUsersWithTrack.find((u) => u.userId === 7)?.lastFmUsername).toBe('user_7');
  });

  it('uses the cached nickname and records the roles it read', async () => {
    const cache = new Map<string, unknown>([['d-7', cachedMember('d-7')]]);
    const { service } = build({ guildUsers: [guildUser({ userId: 7 })] });

    const result = await service.getFilteredUsersForTrack(
      discordGuild(cache), CALLER, 'Radiohead', 'Creep', null, true,
    );

    const row = result.filteredUsersWithTrack.find((u) => u.userId === 7);
    expect(row?.discordName).toBe('Nick d-7');
    expect(row?.roles).toEqual({ read: true, roles: ['r1'] });
  });

  it('records a genuine absence and a failed question differently', async () => {
    // The whole reason `roles` is a tri-state, asserted here so the two paths
    // cannot drift apart from each other or from the album twin.
    const gone = vi.fn(async () => {
      throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
    });
    const goneResult = await build({ guildUsers: [guildUser({ userId: 7 })] }).service
      .getFilteredUsersForTrack(discordGuild(new Map(), gone), CALLER, 'Radiohead', 'Creep', null, true);
    expect(goneResult.filteredUsersWithTrack.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: true,
    });

    const refused = vi.fn(async () => {
      throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
    });
    const refusedResult = await build({ guildUsers: [guildUser({ userId: 7 })] }).service
      .getFilteredUsersForTrack(discordGuild(new Map(), refused), CALLER, 'Radiohead', 'Creep', null, true);
    expect(refusedResult.filteredUsersWithTrack.find((u) => u.userId === 7)?.roles).toEqual({
      read: false,
      absent: false,
    });
  });

  it('does not add the caller when their playcount is unknown, and does when it is a real zero', async () => {
    const unknown = await build().service.getFilteredUsersForTrack(
      discordGuild(), CALLER, 'Radiohead', 'Creep', null, true,
    );
    expect(unknown.filteredUsersWithTrack.map((u) => u.userId)).toEqual([7, 8]);

    const zero = await build().service.getFilteredUsersForTrack(
      discordGuild(), CALLER, 'Radiohead', 'Creep', 0, true,
    );
    expect(zero.filteredUsersWithTrack.find((u) => u.userId === 1)?.playcount).toBe(0);
  });

  it('still honours privacy and bans, because a track leaderboard is still a list of people', async () => {
    const hidden = await build({ guildUsers: [guildUser({ userId: 7, privacyLevel: 'Hide' })] })
      .service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Radiohead', 'Creep', null, true);
    expect(hidden.filteredUsersWithTrack.map((u) => u.userId)).not.toContain(7);

    const banned = await build({ guildUsers: [guildUser({ userId: 7, whoKnowsBanned: true })] })
      .service.getFilteredUsersForTrack(discordGuild(), CALLER, 'Radiohead', 'Creep', null, false);
    expect(banned.filterStats.blockedFiltered).toBe(1);
    expect(banned.filteredUsersWithTrack.map((u) => u.userId)).not.toContain(7);
  });
});

describe('WhoKnowsTrackService.getFriendUsersForTrack', () => {
  const serviceWith = (over: Over, friendRows: WhoKnowsDbRow[]) => {
    const whoKnowsRepository = {
      getIndexedUsersForTrack: vi.fn(async () => INDEXED),
      getFriendUsersForTrack: vi.fn(async () => friendRows),
    } as unknown as IWhoKnowsRepository;
    return {
      service: new WhoKnowsTrackService(
        whoKnowsRepository,
        { getGuildUsers: vi.fn(async () => []) } as unknown as IGuildUserRepository,
        { getGuild: vi.fn(async () => null) } as unknown as GuildService,
        {
          getTrackByNameAndArtist: vi.fn(async () => (over.track === undefined ? { trackId: 77 } : over.track)),
        } as unknown as ITrackRepository,
        {
          getArtistByName: vi.fn(async () => (over.artist === undefined ? { artistId: 9 } : over.artist)),
        } as unknown as IArtistRepository,
      ),
      whoKnowsRepository,
      trackRepository: { getTrackByNameAndArtist: vi.fn(async () => ({ trackId: 77 })) },
    };
  };

  it('returns nothing when the artist is unknown, without asking for friends', async () => {
    const { service, whoKnowsRepository } = serviceWith({ artist: null }, []);
    await expect(service.getFriendUsersForTrack(discordGuild(), 1, 'Nobody', 'Nothing')).resolves.toEqual([]);
    expect(whoKnowsRepository.getFriendUsersForTrack).not.toHaveBeenCalled();
  });

  it('returns nothing when the track is unknown, without asking for friends', async () => {
    const { service, whoKnowsRepository } = serviceWith({ track: null }, []);
    await expect(service.getFriendUsersForTrack(discordGuild(), 1, 'Radiohead', 'Nope')).resolves.toEqual([]);
    expect(whoKnowsRepository.getFriendUsersForTrack).not.toHaveBeenCalled();
  });

  it('scopes the friend query to the guild and the resolved track id', async () => {
    const { service, whoKnowsRepository } = serviceWith({}, []);

    await service.getFriendUsersForTrack(discordGuild(), 5, 'Radiohead', 'Creep');

    expect(whoKnowsRepository.getFriendUsersForTrack).toHaveBeenCalledWith(5, 77, 'g-1');
  });

  it('passes no guild in a DM', async () => {
    const { service, whoKnowsRepository } = serviceWith({}, []);
    await service.getFriendUsersForTrack(null, 5, 'Radiohead', 'Creep');
    expect(whoKnowsRepository.getFriendUsersForTrack).toHaveBeenCalledWith(5, 77, undefined);
  });

  it('maps a row onto a friend, with both name fallbacks', async () => {
    const withNick = serviceWith({}, [
      { userId: 2, playcount: 30, userNameLastFm: 'bob', discordName: 'Bob' },
    ]);
    expect(
      (await withNick.service.getFriendUsersForTrack(discordGuild(), 1, 'Radiohead', 'Creep'))[0],
    ).toEqual({ userId: 2, playcount: 30, lastFmUsername: 'bob', discordName: 'Bob' });

    const withoutNick = serviceWith({}, [{ userId: 2, playcount: 30, userNameLastFm: 'bob' }]);
    expect(
      (await withoutNick.service.getFriendUsersForTrack(discordGuild(), 1, 'Radiohead', 'Creep'))[0]
        ?.discordName,
    ).toBe('bob');

    const withoutAny = serviceWith({}, [{ userId: 2, playcount: 30 }]);
    expect(
      (await withoutAny.service.getFriendUsersForTrack(discordGuild(), 1, 'Radiohead', 'Creep'))[0]
        ?.lastFmUsername,
    ).toBe('user_2');
  });
});