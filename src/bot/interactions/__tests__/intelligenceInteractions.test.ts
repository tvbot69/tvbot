import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { MessageFlags } from 'discord.js';
import { IntelligenceInteractions } from '../intelligenceInteractions';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { ArtworkService } from '@bot/services/artworkService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type {
  AffinityData,
  AffinityNeighbor,
  DiscoveryItem,
  ListeningGapItem,
} from '@bot/services/musicIntelligenceService';
import type { ButtonInteraction } from 'discord.js';

const makeNeighbor = (over: Partial<AffinityNeighbor> = {}): AffinityNeighbor => ({
  userId: 1,
  discordUserId: 'target1',
  userNameLastFm: 'target1',
  displayName: 'TargetOne',
  totalPercentage: 88,
  artistPercentage: 80,
  genrePercentage: 70,
  countryPercentage: 60,
  sharedArtists: ['Radiohead'],
  ...over,
});

const makeAffinity = (over: Partial<AffinityData> = {}): AffinityData => ({
  userDisplayName: 'target1',
  userNameLastFm: 'target1',
  guildName: 'TestGuild',
  neighbors: [makeNeighbor()],
  totalGuildUsers: 4,
  ...over,
});

const makeDiscovery = (over: Partial<DiscoveryItem> = {}): DiscoveryItem => ({
  artistName: 'Boards of Canada',
  firstPlay: new Date('2026-01-01'),
  playcount: 3,
  ...over,
});

const makeGap = (over: Partial<ListeningGapItem> = {}): ListeningGapItem => ({
  name: 'Kid A',
  artistName: 'Radiohead',
  resumeDate: new Date('2026-02-01'),
  prevPlayed: new Date('2025-01-01'),
  gapDays: 400,
  totalPlays: 12,
  ...over,
});

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    guild: {
      id: 'g1',
      name: 'TestGuild',
      iconURL: vi.fn(() => 'https://cdn.discordapp.com/icons/g1/ig.png'),
      members: {
        cache: new Map<string, { displayName: string }>(),
        fetch: vi.fn(async () => null),
      },
    },
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    update: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    guild: { members: { fetch: ReturnType<typeof vi.fn> } };
  };

const build = (over: Record<string, unknown> = {}) => {
  const intelligenceService = {
    getGuildAffinity: vi.fn(async () => makeAffinity()),
    getDiscoveries: vi.fn(async () => [makeDiscovery()]),
    getListeningGaps: vi.fn(async () => [makeGap()]),
    ...(over.intelligenceService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'user1' })),
    ...(over.userService as object),
  };
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => 0x00ff00),
    ...(over.colorService as object),
  };
  const artworkService = {
    getArtistImageUrl: vi.fn(async () => 'https://art/artist.png'),
    getAlbumCoverUrl: vi.fn(async () => 'https://art/album.png'),
    getTrackCoverUrl: vi.fn(async () => 'https://art/track.png'),
    ...(over.artworkService as object),
  };
  const injected = 'artworkService' in over ? (over.artworkService as object | undefined) : artworkService;
  const ii = new IntelligenceInteractions(
    intelligenceService as never,
    userService as never,
    colorService as never,
    injected as never,
  );
  return { ii, intelligenceService, userService, colorService, artworkService };
};

const lastArg = (spy: unknown) => {
  const mock = spy as ReturnType<typeof vi.fn>;
  return mock.mock.calls[mock.mock.calls.length - 1]![0] as Record<string, unknown>;
};

const affinityArg = () =>
  lastArg(IntelligenceBuilders.buildAffinityResponse) as unknown as {
    page: number;
    pageSize: number;
    callerDiscordId: string;
    targetDiscordId: string;
    accentColor: number;
  };

const discoveriesArg = () =>
  lastArg(IntelligenceBuilders.buildDiscoveriesResponse) as unknown as {
    page: number;
    pageSize: number;
    periodDescription: string;
    displayName: string;
    accentColor: number;
  };

const gapsArg = () =>
  lastArg(IntelligenceBuilders.buildListeningGapsResponse) as unknown as {
    page: number;
    pageSize: number;
    entityType: string;
    accentColor: number;
  };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(IntelligenceBuilders, 'buildAffinityResponse').mockReturnValue({ componentsV2Container: {} } as never);
  vi.spyOn(IntelligenceBuilders, 'buildDiscoveriesResponse').mockReturnValue({ componentsV2Container: {} } as never);
  vi.spyOn(IntelligenceBuilders, 'buildListeningGapsResponse').mockReturnValue({ componentsV2Container: {} } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntelligenceInteractions.handleButton — routing', () => {
  it('ignores an unrecognized customId', async () => {
    const { ii, intelligenceService, userService } = build();
    const press = mkButton('something-else:next:caller1:target1:1:2');

    await ii.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('routes affinity-page to the affinity builder only', async () => {
    const { ii, intelligenceService } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(IntelligenceBuilders.buildAffinityResponse).toHaveBeenCalledTimes(1);
    expect(IntelligenceBuilders.buildDiscoveriesResponse).not.toHaveBeenCalled();
    expect(intelligenceService.getDiscoveries).not.toHaveBeenCalled();
  });

  it('routes discoveries-page to the discoveries builder only', async () => {
    const { ii, intelligenceService } = build();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(IntelligenceBuilders.buildDiscoveriesResponse).toHaveBeenCalledTimes(1);
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
    expect(intelligenceService.getListeningGaps).not.toHaveBeenCalled();
  });

  it('routes gaps-page to the gaps builder only', async () => {
    const { ii, intelligenceService } = build();
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:artist:1:3'));

    expect(IntelligenceBuilders.buildListeningGapsResponse).toHaveBeenCalledTimes(1);
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
    expect(intelligenceService.getDiscoveries).not.toHaveBeenCalled();
  });
});

describe('IntelligenceInteractions.handleButton — affinity-page', () => {
  it('returns early when the customId has fewer than 6 parts', async () => {
    const { ii, userService } = build();
    const press = mkButton('affinity-page:first:caller1:target1');

    await ii.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildAffinityResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('navigates to the first page', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:3:3'));

    expect(affinityArg().page).toBe(1);
  });

  it('navigates to the previous page', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:prev:caller1:target1:3:3'));

    expect(affinityArg().page).toBe(2);
  });

  it('clamps the previous page at 1', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:prev:caller1:target1:1:3'));

    expect(affinityArg().page).toBe(1);
  });

  it('navigates to the next page', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:next:caller1:target1:1:3'));

    expect(affinityArg().page).toBe(2);
  });

  it('clamps the next page at totalPages', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:next:caller1:target1:3:3'));

    expect(affinityArg().page).toBe(3);
  });

  it('navigates to the last page', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:last:caller1:target1:1:3'));

    expect(affinityArg().page).toBe(3);
  });

  it('keeps the current page for an unknown action', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:sideways:caller1:target1:2:3'));

    expect(affinityArg().page).toBe(2);
  });

  it('defaults a non-numeric page to 1', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:prev:caller1:target1:abc:3'));

    expect(affinityArg().page).toBe(1);
  });

  it('passes a page size of 12 plus the caller and target ids', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('affinity-page:next:caller1:target1:1:3'));

    expect(affinityArg().pageSize).toBe(12);
    expect(affinityArg().callerDiscordId).toBe('caller1');
    expect(affinityArg().targetDiscordId).toBe('target1');
  });

  it('looks the caller up when the target id is 0', async () => {
    const { ii, userService } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:0:1:3'));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
  });

  it('looks the target up when a target id is present', async () => {
    const { ii, userService } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('target1');
  });

  it('defers update when the target user is not found', async () => {
    const { ii, intelligenceService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton('affinity-page:first:caller1:target1:1:3');

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
  });

  it('defers update when the interaction has no guild', async () => {
    const { ii, intelligenceService } = build();
    const press = mkButton('affinity-page:first:caller1:target1:1:3', { guild: null });

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
  });

  it('resolves the guild with the guild id, resolved user id and guild name', async () => {
    const { ii, intelligenceService } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledWith('g1', 1, 'user1', 'user1', 'TestGuild');
  });

  it('prefers the fetched member displayName over the lastfm username', async () => {
    const { ii, intelligenceService } = build();
    const press = mkButton('affinity-page:first:caller1:target1:1:3', {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        iconURL: vi.fn(() => 'https://cdn.discordapp.com/icons/g1/ig.png'),
        members: { cache: new Map(), fetch: vi.fn(async () => ({ displayName: 'MemberName' })) },
      },
    });

    await ii.handleButton(press);

    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledWith('g1', 1, 'MemberName', 'user1', 'TestGuild');
  });

  it('falls back to the lastfm username when the member fetch fails', async () => {
    const { ii, intelligenceService } = build();
    const press = mkButton('affinity-page:first:caller1:target1:1:3', {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        iconURL: vi.fn(() => 'https://cdn.discordapp.com/icons/g1/ig.png'),
        members: {
          cache: new Map(),
          fetch: vi.fn(async () => {
            throw new Error('Unknown Member');
          }),
        },
      },
    });

    await ii.handleButton(press);

    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledWith('g1', 1, 'user1', 'user1', 'TestGuild');
  });

  it('derives the accent colour from the guild icon', async () => {
    const { ii, colorService } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn.discordapp.com/icons/g1/ig.png');
    expect(affinityArg().accentColor).toBe(0x00ff00);
  });

  it('falls back to the lastfm red when the guild has no icon', async () => {
    const { ii, colorService } = build({
      intelligenceService: { getGuildAffinity: vi.fn(async () => makeAffinity({ neighbors: [] })) },
    });
    const press = mkButton('affinity-page:first:caller1:target1:1:3', {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        iconURL: vi.fn(() => null),
        members: { cache: new Map(), fetch: vi.fn(async () => null) },
      },
    });

    await ii.handleButton(press);

    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    expect(affinityArg().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('recolours from a shared artist when the guild has no icon', async () => {
    const { ii, artworkService, colorService } = build({
      colorService: { getColorFromImageUrl: vi.fn(async () => 0x123456) },
    });
    const press = mkButton('affinity-page:first:caller1:target1:1:3', {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        iconURL: vi.fn(() => null),
        members: { cache: new Map(), fetch: vi.fn(async () => null) },
      },
    });

    await ii.handleButton(press);

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://art/artist.png');
    expect(affinityArg().accentColor).toBe(0x123456);
  });

  it('recolours from a shared artist when the icon colour is the lastfm red', async () => {
    const { ii, artworkService } = build({
      colorService: { getColorFromImageUrl: vi.fn(async () => DiscordConstants.LastFmColorRed) },
    });
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(affinityArg().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('does not recolour from artwork when the icon already gave a distinct colour', async () => {
    const { ii, artworkService } = build();
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('does not recolour when there are no neighbors', async () => {
    const { ii, artworkService } = build({
      intelligenceService: { getGuildAffinity: vi.fn(async () => makeAffinity({ neighbors: [] })) },
      colorService: { getColorFromImageUrl: vi.fn(async () => DiscordConstants.LastFmColorRed) },
    });
    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('resolves the artwork service from the container when it was not injected', async () => {
    const artworkService = {
      getArtistImageUrl: vi.fn(async () => 'https://art/shared.png'),
      getAlbumCoverUrl: vi.fn(async () => null),
      getTrackCoverUrl: vi.fn(async () => null),
    };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) =>
      token === ArtworkService ? artworkService : {}) as never);
    const { ii } = build({
      artworkService: undefined,
      colorService: { getColorFromImageUrl: vi.fn(async () => DiscordConstants.LastFmColorRed) },
    });

    await ii.handleButton(mkButton('affinity-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
  });

  it('updates the interaction with the ComponentsV2 container', async () => {
    const { ii } = build();
    const press = mkButton('affinity-page:first:caller1:target1:1:3');

    await ii.handleButton(press);

    expect(press.update).toHaveBeenCalledWith({
      components: [{}],
      flags: MessageFlags.IsComponentsV2,
    });
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('falls back to deferUpdate when update throws', async () => {
    const { ii } = build();
    const press = mkButton('affinity-page:first:caller1:target1:1:3', {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not touch the interaction when the response has no container', async () => {
    const { ii } = build();
    vi.spyOn(IntelligenceBuilders, 'buildAffinityResponse').mockReturnValue({} as never);
    const press = mkButton('affinity-page:first:caller1:target1:1:3');

    await ii.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('IntelligenceInteractions.handleButton — discoveries-page', () => {
  it('returns early when the customId has fewer than 6 parts', async () => {
    const { ii, userService } = build();
    const press = mkButton('discoveries-page:first:caller1:target1');

    await ii.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildDiscoveriesResponse).not.toHaveBeenCalled();
  });

  it('navigates through every page action', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:3:3'));
    expect(discoveriesArg().page).toBe(1);
    await ii.handleButton(mkButton('discoveries-page:prev:caller1:target1:3:3'));
    expect(discoveriesArg().page).toBe(2);
    await ii.handleButton(mkButton('discoveries-page:next:caller1:target1:1:3'));
    expect(discoveriesArg().page).toBe(2);
    await ii.handleButton(mkButton('discoveries-page:last:caller1:target1:1:3'));
    expect(discoveriesArg().page).toBe(3);
  });

  it('keeps the current page for an unknown action', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('discoveries-page:sideways:caller1:target1:2:3'));

    expect(discoveriesArg().page).toBe(2);
  });

  it('uses a page size of 10 and the 90 day period description', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(discoveriesArg().pageSize).toBe(10);
    expect(discoveriesArg().periodDescription).toBe('the past 90 days');
  });

  it('queries discoveries for a 90 day window ending now', async () => {
    const { ii, intelligenceService } = build();
    const before = Date.now();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    const [userId, start, end] = intelligenceService.getDiscoveries.mock.calls[0] as unknown as [number, Date, Date];
    expect(userId).toBe(1);
    expect(end.getTime()).toBeGreaterThanOrEqual(before);
    expect(start.getTime()).toBeLessThanOrEqual(before - 89 * 24 * 60 * 60 * 1000);
  });

  it('looks the caller up when the target id is 0', async () => {
    const { ii, userService } = build();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:0:1:3'));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
  });

  it('defers update when the target user is not found', async () => {
    const { ii, intelligenceService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton('discoveries-page:first:caller1:target1:1:3');

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(intelligenceService.getDiscoveries).not.toHaveBeenCalled();
  });

  it('prefers the cached member displayName', async () => {
    const { ii } = build();
    const press = mkButton('discoveries-page:first:caller1:target1:1:3', {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        iconURL: vi.fn(() => null),
        members: { cache: new Map([['target1', { displayName: 'CachedName' }]]), fetch: vi.fn(async () => null) },
      },
    });

    await ii.handleButton(press);

    expect(discoveriesArg().displayName).toBe('CachedName');
  });

  it('falls back to the lastfm username when no member is cached', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(discoveriesArg().displayName).toBe('user1');
  });

  it('derives the accent colour from the first discovered artist artwork', async () => {
    const { ii, artworkService } = build();
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Boards of Canada');
    expect(discoveriesArg().accentColor).toBe(0x00ff00);
  });

  it('keeps the lastfm red when there are no discoveries', async () => {
    const { ii, artworkService } = build({
      intelligenceService: { getDiscoveries: vi.fn(async () => [] as DiscoveryItem[]) },
    });
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
    expect(discoveriesArg().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('keeps the lastfm red when the artwork lookup returns null', async () => {
    const { ii } = build({ artworkService: { getArtistImageUrl: vi.fn(async () => null) } });
    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(discoveriesArg().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('resolves the artwork service from the container when it was not injected', async () => {
    const artworkService = {
      getArtistImageUrl: vi.fn(async () => 'https://art/artist.png'),
      getAlbumCoverUrl: vi.fn(async () => null),
      getTrackCoverUrl: vi.fn(async () => null),
    };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) =>
      token === ArtworkService ? artworkService : {}) as never);
    const { ii } = build({ artworkService: undefined });

    await ii.handleButton(mkButton('discoveries-page:first:caller1:target1:1:3'));

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Boards of Canada');
  });

  it('updates the interaction with the ComponentsV2 container', async () => {
    const { ii } = build();
    const press = mkButton('discoveries-page:first:caller1:target1:1:3');

    await ii.handleButton(press);

    expect(press.update).toHaveBeenCalledWith({ components: [{}], flags: MessageFlags.IsComponentsV2 });
  });

  it('falls back to deferUpdate when update throws', async () => {
    const { ii } = build();
    const press = mkButton('discoveries-page:first:caller1:target1:1:3', {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not touch the interaction when the response has no container', async () => {
    const { ii } = build();
    vi.spyOn(IntelligenceBuilders, 'buildDiscoveriesResponse').mockReturnValue({} as never);
    const press = mkButton('discoveries-page:first:caller1:target1:1:3');

    await ii.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('IntelligenceInteractions.handleButton — gaps-page', () => {
  it('returns early when the customId has fewer than 7 parts', async () => {
    const { ii, userService } = build();
    const press = mkButton('gaps-page:first:caller1:target1:artist');

    await ii.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildListeningGapsResponse).not.toHaveBeenCalled();
  });

  it('navigates through every page action', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:artist:3:3'));
    expect(gapsArg().page).toBe(1);
    await ii.handleButton(mkButton('gaps-page:prev:caller1:target1:artist:3:3'));
    expect(gapsArg().page).toBe(2);
    await ii.handleButton(mkButton('gaps-page:next:caller1:target1:artist:1:3'));
    expect(gapsArg().page).toBe(2);
    await ii.handleButton(mkButton('gaps-page:last:caller1:target1:artist:1:3'));
    expect(gapsArg().page).toBe(3);
  });

  it('keeps the current page for an unknown action', async () => {
    const { ii } = build();
    await ii.handleButton(mkButton('gaps-page:sideways:caller1:target1:artist:2:3'));

    expect(gapsArg().page).toBe(2);
  });

  it('queries gaps for a 90 day window and the requested entity type', async () => {
    const { ii, intelligenceService } = build();
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:album:1:3'));

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'album', 90);
    expect(gapsArg().entityType).toBe('album');
    expect(gapsArg().pageSize).toBe(10);
  });

  it('defers update when the target user is not found', async () => {
    const { ii, intelligenceService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton('gaps-page:first:caller1:target1:artist:1:3');

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(intelligenceService.getListeningGaps).not.toHaveBeenCalled();
  });

  it('uses the artist artwork lookup for artist gaps', async () => {
    const { ii, artworkService } = build();
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:artist:1:3'));

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Kid A');
    expect(gapsArg().accentColor).toBe(0x00ff00);
  });

  it('uses the album cover lookup for album gaps', async () => {
    const { ii, artworkService } = build();
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:album:1:3'));

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('Kid A', 'Radiohead');
  });

  it('uses the track cover lookup for track gaps', async () => {
    const { ii, artworkService } = build();
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:track:1:3'));

    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('Kid A', 'Radiohead');
  });

  it('passes an empty artist name when the gap has none', async () => {
    const { ii, artworkService } = build({
      intelligenceService: { getListeningGaps: vi.fn(async () => [makeGap({ artistName: undefined })]) },
    });
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:album:1:3'));

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('Kid A', '');
  });

  it('keeps the lastfm red when there are no gaps', async () => {
    const { ii, artworkService } = build({
      intelligenceService: { getListeningGaps: vi.fn(async () => [] as ListeningGapItem[]) },
    });
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:artist:1:3'));

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
    expect(gapsArg().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('keeps the lastfm red when the artwork lookup returns null', async () => {
    const { ii } = build({ artworkService: { getAlbumCoverUrl: vi.fn(async () => null) } });
    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:album:1:3'));

    expect(gapsArg().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('prefers the cached member displayName', async () => {
    const { ii } = build();
    const press = mkButton('gaps-page:first:caller1:target1:artist:1:3', {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        iconURL: vi.fn(() => null),
        members: { cache: new Map([['target1', { displayName: 'GapName' }]]), fetch: vi.fn(async () => null) },
      },
    });

    await ii.handleButton(press);

    expect(gapsArg()).toEqual(expect.objectContaining({ displayName: 'GapName' }));
  });

  it('resolves the artwork service from the container when it was not injected', async () => {
    const artworkService = {
      getArtistImageUrl: vi.fn(async () => null),
      getAlbumCoverUrl: vi.fn(async () => 'https://art/album.png'),
      getTrackCoverUrl: vi.fn(async () => null),
    };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) =>
      token === ArtworkService ? artworkService : {}) as never);
    const { ii } = build({ artworkService: undefined });

    await ii.handleButton(mkButton('gaps-page:first:caller1:target1:album:1:3'));

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('Kid A', 'Radiohead');
  });

  it('updates the interaction with the ComponentsV2 container', async () => {
    const { ii } = build();
    const press = mkButton('gaps-page:first:caller1:target1:artist:1:3');

    await ii.handleButton(press);

    expect(press.update).toHaveBeenCalledWith({ components: [{}], flags: MessageFlags.IsComponentsV2 });
  });

  it('falls back to deferUpdate when update throws', async () => {
    const { ii } = build();
    const press = mkButton('gaps-page:first:caller1:target1:artist:1:3', {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ii.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not touch the interaction when the response has no container', async () => {
    const { ii } = build();
    vi.spyOn(IntelligenceBuilders, 'buildListeningGapsResponse').mockReturnValue({} as never);
    const press = mkButton('gaps-page:first:caller1:target1:artist:1:3');

    await ii.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});
