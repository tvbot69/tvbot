import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { RecentInteractions } from '@bot/interactions/library/recentInteractions';
import { RecentBuilders } from '@bot/builders/library/recentBuilders';
import type { RecentTrackList } from '@domain/models/recentTrack';

const TARGET_ID = 'target1';
const SESSION_KEY = 'session-key-123';

const makeRecentData = (over: Partial<RecentTrackList> = {}): RecentTrackList => ({
  tracks: [
    {
      name: 'Everything In Its Right Place',
      artistName: 'Radiohead',
      albumName: 'Kid A',
      imageUrl: 'https://cdn/first-track.png',
      nowPlaying: true,
      timePlayed: new Date('2025-01-01T00:00:00Z'),
    },
    {
      name: 'Idioteque',
      artistName: 'Radiohead',
      albumName: 'Kid A',
      imageUrl: 'https://cdn/second-track.png',
      nowPlaying: false,
    },
  ],
  totalPages: 40,
  totalScrobbles: 240,
  ...over,
});

const makeUser = (over: Record<string, unknown> = {}) =>
  ({
    userId: 1,
    userNameLastFm: 'lfmuser',
    discordUserId: TARGET_ID,
    sessionKey: SESSION_KEY,
    ...over,
  }) as never;

const makeContainerResponse = () =>
  ({
    isComponentsV2: true,
    componentsV2Container: { id: 77, toJSON: () => ({ type: 17, id: 77 }) },
  }) as never;

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    guild: { members: { cache: new Map() } },
    user: { id: 'caller1' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const lastfmRepo = {
    getUserRecentTracksWithMetadata: vi.fn(
      async (
        _userName: string,
        _count?: number,
        _page?: number,
        _fromUnixTimestamp?: number,
        _sessionKey?: string,
      ) => makeRecentData(),
    ),
    ...(over.lastfmRepo as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    ...(over.userService as object),
  };
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => 0x112233),
    ...(over.colorService as object),
  };
  const ri = new RecentInteractions(lastfmRepo as never, userService as never, colorService as never);
  return { ri, lastfmRepo, userService, colorService };
};

const spyBuilder = () => vi.spyOn(RecentBuilders, 'buildRecentTracksResponse').mockReturnValue(makeContainerResponse());

const editPayload = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RecentInteractions.handleButton — customId routing', () => {
  it('does nothing for a customId without the recent: prefix', async () => {
    const { ri, lastfmRepo, userService } = build();
    spyBuilder();
    const press = mkButton('friends:overview:0');

    await ri.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(lastfmRepo.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('does nothing for a recent: customId with fewer than 5 parts', async () => {
    const { ri, lastfmRepo } = build();
    spyBuilder();
    const press = mkButton('recent:next:1');

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['four parts', 'recent:next:1:target1'],
    ['a bare prefix', 'recent:'],
  ])('returns early for %s', async (_label, customId) => {
    const { ri, lastfmRepo } = build();
    spyBuilder();
    const press = mkButton(customId);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('validates only the segment count — five empty segments still hit Last.fm', async () => {
    const { ri, lastfmRepo } = build();
    const spy = spyBuilder();
    const press = mkButton('recent::::');

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata).toHaveBeenCalledWith('', 6, 2, undefined, SESSION_KEY);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('routes recent:next to the forward page', async () => {
    const { ri, lastfmRepo } = build();
    const spy = spyBuilder();
    const press = mkButton(`recent:next:3:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'lfmuser',
      6,
      4,
      undefined,
      SESSION_KEY,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('routes recent:prev to the backward page', async () => {
    const { ri, lastfmRepo } = build();
    spyBuilder();
    const press = mkButton(`recent:prev:3:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'lfmuser',
      6,
      2,
      undefined,
      SESSION_KEY,
    );
    expect(press.update).toHaveBeenCalledTimes(1);
  });
});

describe('RecentInteractions — page arithmetic', () => {
  const pageOf = async (customId: string) => {
    const { ri, lastfmRepo } = build();
    spyBuilder();
    await ri.handleButton(mkButton(customId));
    return lastfmRepo.getUserRecentTracksWithMetadata.mock.calls[0]![2];
  };

  it('clamps prev at page 1 to page 1', async () => {
    expect(await pageOf(`recent:prev:1:${TARGET_ID}:lfmuser`)).toBe(1);
  });

  it('clamps prev from page 2 to page 1', async () => {
    expect(await pageOf(`recent:prev:2:${TARGET_ID}:lfmuser`)).toBe(1);
  });

  it('clamps next at page 80 to page 80', async () => {
    expect(await pageOf(`recent:next:80:${TARGET_ID}:lfmuser`)).toBe(80);
  });

  it('allows next past page 80 to be clamped', async () => {
    expect(await pageOf(`recent:next:120:${TARGET_ID}:lfmuser`)).toBe(80);
  });

  it('treats an unrecognised action as next', async () => {
    expect(await pageOf(`recent:sideways:4:${TARGET_ID}:lfmuser`)).toBe(5);
  });

  it('defaults a non-numeric current page to 1', async () => {
    expect(await pageOf(`recent:next:abc:${TARGET_ID}:lfmuser`)).toBe(2);
  });

  it('defaults a page of 0 to 1', async () => {
    expect(await pageOf(`recent:next:0:${TARGET_ID}:lfmuser`)).toBe(2);
  });
});

describe('RecentInteractions — user and identity resolution', () => {
  it('looks the user up by the target discord id', async () => {
    const { ri, userService } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith(TARGET_ID);
  });

  it('passes the session key through to the Last.fm call', async () => {
    const { ri, lastfmRepo } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata.mock.calls[0]![4]).toBe(SESSION_KEY);
  });

  it('passes undefined as the session key when the user is not registered', async () => {
    const { ri, lastfmRepo } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'lfmuser',
      6,
      2,
      undefined,
      undefined,
    );
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('survives a rejecting user lookup and still fetches recents', async () => {
    const { ri, lastfmRepo } = build({
      userService: {
        getUserByDiscordId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata.mock.calls[0]![4]).toBeUndefined();
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('URL-decodes the Last.fm name segment', async () => {
    const { ri, lastfmRepo } = build();
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:${encodeURIComponent('two words')}`);

    await ri.handleButton(press);

    expect(lastfmRepo.getUserRecentTracksWithMetadata.mock.calls[0]![0]).toBe('two words');
    expect(spy.mock.calls[0]![0]).toBe('two words');
  });

  it('uses the cached guild member displayName when present', async () => {
    const { ri } = build();
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`, {
      guild: { members: { cache: new Map([[TARGET_ID, { displayName: 'CoolMember' }]]) } },
    });

    await ri.handleButton(press);

    expect(spy.mock.calls[0]![1]).toBe('CoolMember');
  });

  it('falls back to the Last.fm name when the member is not cached', async () => {
    const { ri } = build();
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(spy.mock.calls[0]![1]).toBe('lfmuser');
  });

  it('falls back to the Last.fm name when the interaction has no guild', async () => {
    const { ri } = build();
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`, { guild: undefined });

    await ri.handleButton(press);

    expect(spy.mock.calls[0]![1]).toBe('lfmuser');
  });
});

describe('RecentInteractions — empty result paths', () => {
  it('defers and returns when the track list is empty', async () => {
    const { ri, colorService } = build({
      lastfmRepo: {
        getUserRecentTracksWithMetadata: vi.fn(async () => makeRecentData({ tracks: [] })),
      },
    });
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('defers and returns when the repository returns nothing', async () => {
    const { ri } = build({
      lastfmRepo: { getUserRecentTracksWithMetadata: vi.fn(async () => null) },
    });
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('survives a deferUpdate rejection on the empty path', async () => {
    const { ri } = build({
      lastfmRepo: {
        getUserRecentTracksWithMetadata: vi.fn(async () => makeRecentData({ tracks: [] })),
      },
    });
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`, {
      deferUpdate: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

    await expect(ri.handleButton(press)).resolves.toBeUndefined();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('RecentInteractions — response building', () => {
  it('passes the identity, the track list, the new page and the accent colour to the builder', async () => {
    const { ri } = build();
    const spy = spyBuilder();
    const press = mkButton(`recent:next:2:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(spy).toHaveBeenCalledWith(
      'lfmuser',
      'lfmuser',
      TARGET_ID,
      expect.objectContaining({ totalScrobbles: 240, totalPages: 40 }),
      3,
      0x112233,
    );
  });

  it('derives the accent colour from the first track image', async () => {
    const { ri, colorService } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn/first-track.png');
  });

  it('updates the message with the container and the Components V2 flag', async () => {
    const { ri } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    const payload = editPayload(press.update);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toEqual([expect.objectContaining({ id: 77 })]);
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('skips the update entirely when the builder returns no container', async () => {
    const { ri } = build();
    vi.spyOn(RecentBuilders, 'buildRecentTracksResponse').mockReturnValue({} as never);
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('updates only once per press', async () => {
    const { ri } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.reply).not.toHaveBeenCalled();
  });
});

describe('RecentInteractions.handleButton — error path', () => {
  it('defers instead of updating when the Last.fm call rejects', async () => {
    const { ri } = build({
      lastfmRepo: {
        getUserRecentTracksWithMetadata: vi.fn(async () => {
          throw new Error('lastfm down');
        }),
      },
    });
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await expect(ri.handleButton(press)).resolves.toBeUndefined();

    expect(spy).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('defers instead of updating when the accent colour lookup rejects', async () => {
    const { ri } = build({
      colorService: {
        getColorFromImageUrl: vi.fn(async () => {
          throw new Error('bad image');
        }),
      },
    });
    const spy = spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await expect(ri.handleButton(press)).resolves.toBeUndefined();

    expect(spy).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('defers instead of updating when the builder throws', async () => {
    const { ri } = build();
    vi.spyOn(RecentBuilders, 'buildRecentTracksResponse').mockImplementation(() => {
      throw new Error('build failed');
    });
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await expect(ri.handleButton(press)).resolves.toBeUndefined();

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('falls back to deferUpdate when interaction.update rejects', async () => {
    const { ri } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`, {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ri.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('survives a deferUpdate rejection in the update fallback', async () => {
    const { ri } = build();
    spyBuilder();
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`, {
      update: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
      deferUpdate: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

    await expect(ri.handleButton(press)).resolves.toBeUndefined();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('never sends a user-facing reply on any error path', async () => {
    const { ri } = build({
      lastfmRepo: {
        getUserRecentTracksWithMetadata: vi.fn(async () => {
          throw new Error('lastfm down');
        }),
      },
    });
    const press = mkButton(`recent:next:1:${TARGET_ID}:lfmuser`);

    await ri.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });
});
