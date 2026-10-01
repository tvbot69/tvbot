import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArtistInteractions } from '@bot/interactions/artistInteractions';
import { ArtistBuilders } from '@bot/builders/artistBuilders';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import type { ButtonInteraction } from 'discord.js';

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1', username: 'Tester' },
    guild: { id: 'g1', name: 'Test Guild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'Tester', discordUserId: 'u1' })),
    ...(over.userService as object),
  };
  const artistTrackService = {
    getTopTracksForArtist: vi.fn(async () => []),
    getTopAlbumsForArtist: vi.fn(async () => []),
    getArtistRecentPlays: vi.fn(async () => []),
    getServerArtistStats: vi.fn(async () => null),
    getTotalArtistPlays: vi.fn(async () => 0),
    ...(over.artistTrackService as object),
  };
  const musicBrainzService = {
    getArtistInfo: vi.fn(async () => null),
    getArtistData: vi.fn(async () => null),
    ...(over.musicBrainzService as object),
  };
  const genreService = {
    getGenresForArtist: vi.fn(async () => []),
    ...(over.genreService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const spotifySearchApi = {
    searchArtists: vi.fn(async () => []),
    ...(over.spotifySearchApi as object),
  };
  const lastfmRepository = {
    getArtistInfo: vi.fn(async () => null),
    ...(over.lastfmRepository as object),
  };
  const ai = new ArtistInteractions(
    artistTrackService as never,
    musicBrainzService as never,
    genreService as never,
    userService as never,
    colorService as never,
    spotifySearchApi as never,
    lastfmRepository as never,
  );
  return { ai, userService, artistTrackService, lastfmRepository, spotifySearchApi };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ArtistBuilders, 'buildArtistOverviewResponse').mockReturnValue({ content: 'overview' } as never);
  vi.spyOn(ArtistBuilders, 'buildArtistInfoResponse').mockReturnValue({ content: 'info' } as never);
  vi.spyOn(ArtistBuilders, 'buildArtistTopAlbumsResponse').mockReturnValue({ content: 'albums' } as never);
  vi.spyOn(ArtistTrackBuilders, 'buildArtistTopTracksResponse').mockReturnValue({ content: 'tracks' } as never);
});

describe('ArtistInteractions.handle', () => {
  it('handles artist-overview', async () => {
    const { ai } = build();
    await ai.handle(mkButton('artist-overview:Radiohead'));
    expect(ArtistBuilders.buildArtistOverviewResponse).toHaveBeenCalled();
  });

  it('handles artist-info', async () => {
    const { ai } = build();
    await ai.handle(mkButton('artist-info:Radiohead'));
    expect(ArtistBuilders.buildArtistInfoResponse).toHaveBeenCalled();
  });

  it('handles artist-tracks', async () => {
    const { ai, artistTrackService } = build();
    await ai.handle(mkButton('artist-tracks:Radiohead'));
    expect(artistTrackService.getTopTracksForArtist).toHaveBeenCalledWith(1, 'Radiohead');
    expect(ArtistTrackBuilders.buildArtistTopTracksResponse).toHaveBeenCalled();
  });

  it('handles artist-albums', async () => {
    const { ai, artistTrackService } = build();
    await ai.handle(mkButton('artist-albums:Radiohead'));
    expect(artistTrackService.getTopAlbumsForArtist).toHaveBeenCalled();
    expect(ArtistBuilders.buildArtistTopAlbumsResponse).toHaveBeenCalled();
  });

  it('handles aab pagination first', async () => {
    const { ai } = build();
    await ai.handle(mkButton('aab:first:5:Radiohead'));
    expect(ArtistBuilders.buildArtistTopAlbumsResponse).toHaveBeenCalled();
  });

  it('handles aab pagination prev', async () => {
    const { ai } = build();
    await ai.handle(mkButton('aab:prev:5:Radiohead'));
    expect(ArtistBuilders.buildArtistTopAlbumsResponse).toHaveBeenCalled();
  });

  it('handles aab pagination next', async () => {
    const { ai } = build();
    await ai.handle(mkButton('aab:next:0:Radiohead'));
    expect(ArtistBuilders.buildArtistTopAlbumsResponse).toHaveBeenCalled();
  });

  it('handles aab pagination last', async () => {
    const { ai } = build();
    await ai.handle(mkButton('aab:last:0:Radiohead'));
    expect(ArtistBuilders.buildArtistTopAlbumsResponse).toHaveBeenCalled();
  });

  it('does nothing for unknown customId', async () => {
    const { ai } = build();
    const press = mkButton('unknown:foo');
    await ai.handle(press);
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('defers update when the user is not registered', async () => {
    const { ai } = build({
      userService: { getUserByDiscordId: vi.fn(async () => null) },
    });
    const press = mkButton('artist-overview:Unknown');
    await ai.handle(press);
    expect(press.deferUpdate).toHaveBeenCalled();
  });
});

describe('ArtistInteractions.resolveTargetUser', () => {
  const privates = (ai: ArtistInteractions) =>
    ai as unknown as { resolveTargetUser: (a: string, b: string) => Promise<{ userId: number } | null> };

  it('returns the target user when registered', async () => {
    const { ai, userService } = build();
    const user = await privates(ai).resolveTargetUser('target', 'fallback');
    expect(user?.userId).toBe(1);
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('target');
  });

  it('falls back to the interaction user when the target is unregistered', async () => {
    const { ai } = build({
      userService: {
        getUserByDiscordId: vi.fn(async (id: string) => (id === 'fallback' ? { userId: 7 } : null)),
      },
    });
    const user = await privates(ai).resolveTargetUser('target', 'fallback');
    expect(user?.userId).toBe(7);
  });
});

describe('ArtistInteractions.getArtistImage', () => {
  const privates = (ai: ArtistInteractions) =>
    ai as unknown as { getArtistImage: (a: unknown) => Promise<string | null> };

  it('returns the cached Spotify image without any API call', async () => {
    const { ai, spotifySearchApi } = build();
    const result = await privates(ai).getArtistImage({
      artistId: 1, name: 'Radiohead', spotifyImageUrl: 'https://img/spotify.jpg', deezerImageUrl: null,
    });
    expect(result).toBe('https://img/spotify.jpg');
    expect(spotifySearchApi.searchArtists).not.toHaveBeenCalled();
  });

  it('falls back to the cached Deezer image', async () => {
    const { ai } = build();
    const result = await privates(ai).getArtistImage({
      artistId: 1, name: 'Radiohead', spotifyImageUrl: null, deezerImageUrl: 'https://img/deezer.jpg',
    });
    expect(result).toBe('https://img/deezer.jpg');
  });

  it('returns null when Spotify has no image and the lookup throws', async () => {
    const { ai } = build({
      spotifySearchApi: { searchArtists: vi.fn(async () => { throw new Error('down'); }) },
    });
    const result = await privates(ai).getArtistImage({
      artistId: 1, name: 'Radiohead', spotifyImageUrl: null, deezerImageUrl: null,
    });
    expect(result).toBeNull();
  });
});
