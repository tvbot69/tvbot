import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { StreamingSlashCommands } from '../streamingSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';

const mkUser = (over: Partial<User> = {}): User =>
  ({ userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', ...over }) as User;

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { id: '222', name: 'Test Guild', iconURL: () => 'https://img/guild.png' },
    prefix: '/',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const mkTrack = (over: Partial<RecentTrack> = {}): RecentTrack =>
  ({
    name: 'Airbag',
    artistName: 'Radiohead',
    albumName: 'OK Computer',
    nowPlaying: false,
    ...over,
  }) as RecentTrack;

const subCmd = (sub: string, opts: Record<string, unknown> = {}) => ({
  getSubcommand: () => sub,
  getString: (n: string) => (typeof opts[n] === 'string' ? (opts[n] as string) : null),
  getInteger: (n: string) => (typeof opts[n] === 'number' ? (opts[n] as number) : null),
  getUser: (n: string) => (opts[n] ? { id: opts[n] } : null),
});

const build = () => {
  const userService = { getUserByDiscordId: vi.fn(async () => mkUser()) };
  const spotifySearchApi = {
    searchTracks: vi.fn(async () => []),
    searchAlbums: vi.fn(async () => []),
    searchArtists: vi.fn(async () => []),
  };
  const appleMusicService = {
    searchSong: vi.fn(async () => null),
    searchAlbum: vi.fn(async () => null),
    searchArtist: vi.fn(async () => null),
  };
  const prefixService = { getPrefix: vi.fn(async () => '/') };
  const lastFmRepository = { getUserRecentTracks: vi.fn(async () => [] as RecentTrack[]) };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0xff0000) };
  const service = new StreamingSlashCommands(
    userService as never,
    spotifySearchApi as never,
    appleMusicService as never,
    prefixService as never,
    lastFmRepository as never,
    colorService as never,
  );
  return { service, userService, spotifySearchApi, appleMusicService, prefixService, lastFmRepository };
};

const call = (service: StreamingSlashCommands, name: string, ...args: unknown[]) => {
  const handlers = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse; content?: string; embed: { data: { description?: string } } }>>;
  return handlers[name]!.bind(service)(...args);
};

const execute = (service: StreamingSlashCommands, cmdIndex: number, context: ContextModel) =>
  service.commands[cmdIndex]!.executeAsync(context);

describe('StreamingSlashCommands command table', () => {
  it('gives every command a unique name', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('registers all expected commands', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(names).toContain('spotify');
    expect(names).toContain('applemusic');
  });
});

describe('StreamingSlashCommands spotify routing', () => {
  it('routes the track subcommand to spotifyTrackSlashAsync', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/abc' } },
    ]);
    const ctx = mkContext({ interaction: { options: subCmd('track', { query: 'radiohead airbag' }) } });
    const result = await execute(service, 0, ctx);
    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('radiohead airbag', 1);
    expect(result.content).toBe('https://open.spotify.com/track/abc');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
  });

  it('routes the album subcommand to spotifyAlbumSlashAsync', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/album/xyz' } },
    ]);
    const ctx = mkContext({ interaction: { options: subCmd('album', { query: 'ok computer' }) } });
    const result = await execute(service, 0, ctx);
    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('ok computer', 1);
    expect(result.content).toBe('https://open.spotify.com/album/xyz');
  });

  it('routes the artist subcommand to spotifyArtistSlashAsync', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/artist/r' } },
    ]);
    const ctx = mkContext({ interaction: { options: subCmd('artist', { query: 'radiohead' }) } });
    const result = await execute(service, 0, ctx);
    expect(spotifySearchApi.searchArtists).toHaveBeenCalledWith('radiohead', 1);
    expect(result.content).toBe('https://open.spotify.com/artist/r');
  });

  it('defaults to track when no subcommand is given', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/def' } },
    ]);
    const ctx = mkContext({ interaction: { options: subCmd('', { query: 'airbag' }) } });
    const result = await execute(service, 0, ctx);
    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('airbag', 1);
    expect(result.content).toBe('https://open.spotify.com/track/def');
  });

  it('routes applemusic command to appleMusicSlashAsync', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: 'https://music.apple.com/us/album/airbag/123',
    });
    const ctx = mkContext({ interaction: { options: { getString: (n: string) => (n === 'query' ? 'airbag' : null) } } });
    const result = await execute(service, 1, ctx);
    expect(appleMusicService.searchSong).toHaveBeenCalledWith('airbag');
    expect(result.content).toBe('https://music.apple.com/us/album/airbag/123');
  });
});

describe('StreamingSlashCommands.spotifyTrackSlashAsync', () => {
  it('returns the Spotify track URL when query is provided', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/111' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'radiohead airbag' } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://open.spotify.com/track/111');
  });

  it('trims the query before searching', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/111' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => '  airbag  ' } } });
    await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('airbag', 1);
  });

  it('falls back to album search when track search returns nothing', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/album/fallback' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'ok computer' } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('ok computer', 1);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://open.spotify.com/album/fallback');
  });

  it('falls back to album search when track result has no external_urls', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([{ external_urls: {} }]);
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/album/fb2' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'paranoid android' } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.content).toBe('https://open.spotify.com/album/fb2');
  });

  it('returns NotFound when neither track nor album found', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'nonexistent song' } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns Error when Spotify search throws', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network fail'));
    const ctx = mkContext({ interaction: { options: { getString: () => 'anything' } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('returns error when user is not registered and no query given', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('not connected');
  });

  it('returns error when user has no Last.fm username and no query given', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(mkUser({ userNameLastFm: '' }));
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns error when no recent tracks found', async () => {
    const { service, lastFmRepository } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('No recent tracks');
  });

  it('resolves query from nowPlaying recent track', async () => {
    const { service, lastFmRepository, spotifySearchApi } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Old Song', artistName: 'Old Artist' }),
      mkTrack({ name: 'Current Song', artistName: 'Current Artist', nowPlaying: true }),
    ]);
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/np' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('Current Artist Current Song', 1);
    expect(result.content).toBe('https://open.spotify.com/track/np');
  });

  it('falls back to first recent track when none is nowPlaying', async () => {
    const { service, lastFmRepository, spotifySearchApi } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'First Song', artistName: 'First Artist' }),
      mkTrack({ name: 'Second Song', artistName: 'Second Artist' }),
    ]);
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/first' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('First Artist First Song', 1);
    expect(result.content).toBe('https://open.spotify.com/track/first');
  });

  it('returns error when recent track has no artist or name', async () => {
    const { service, lastFmRepository } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: '', artistName: '' }),
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('Could not determine track details');
  });

  it('returns error when Last.fm repository throws', async () => {
    const { service, lastFmRepository } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(result.embed.data.description).toContain('Failed to fetch');
  });

  it('passes sessionKey to getUserRecentTracks when available', async () => {
    const { service, lastFmRepository, spotifySearchApi } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Song', artistName: 'Artist' }),
    ]);
    (spotifySearchApi.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/track/s' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    await call(service, 'spotifyTrackSlashAsync', ctx);
    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalledWith(
      'DreadRock', 2, 1, undefined, 'SK',
    );
  });
});

describe('StreamingSlashCommands.spotifyAlbumSlashAsync', () => {
  it('returns the Spotify album URL when query is provided', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/album/222' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'ok computer' } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://open.spotify.com/album/222');
  });

  it('returns NotFound when no album found', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'unknown album' } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns Error when Spotify album search throws', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'));
    const ctx = mkContext({ interaction: { options: { getString: () => 'anything' } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('resolves album query from nowPlaying recent track', async () => {
    const { service, lastFmRepository, spotifySearchApi } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: true }),
    ]);
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/album/np-album' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('Radiohead OK Computer', 1);
    expect(result.content).toBe('https://open.spotify.com/album/np-album');
  });

  it('uses artist-only query when albumName is empty', async () => {
    const { service, lastFmRepository, spotifySearchApi } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Airbag', artistName: 'Radiohead', albumName: '' }),
    ]);
    (spotifySearchApi.searchAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/album/a-only' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('Radiohead', 1);
    expect(result.content).toBe('https://open.spotify.com/album/a-only');
  });

  it('returns error when no recent tracks for album resolution', async () => {
    const { service, lastFmRepository } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns error when album resolution throws', async () => {
    const { service, lastFmRepository } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyAlbumSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });
});

describe('StreamingSlashCommands.spotifyArtistSlashAsync', () => {
  it('returns the Spotify artist URL when query is provided', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/artist/333' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'radiohead' } } });
    const result = await call(service, 'spotifyArtistSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://open.spotify.com/artist/333');
  });

  it('returns NotFound when no artist found', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchArtists as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = mkContext({ interaction: { options: { getString: () => 'unknown artist' } } });
    const result = await call(service, 'spotifyArtistSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns Error when Spotify artist search throws', async () => {
    const { service, spotifySearchApi } = build();
    (spotifySearchApi.searchArtists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('429'));
    const ctx = mkContext({ interaction: { options: { getString: () => 'anything' } } });
    const result = await call(service, 'spotifyArtistSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('resolves artist query from nowPlaying recent track', async () => {
    const { service, lastFmRepository, spotifySearchApi } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Airbag', artistName: 'Radiohead', nowPlaying: true }),
    ]);
    (spotifySearchApi.searchArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      { external_urls: { spotify: 'https://open.spotify.com/artist/np' } },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyArtistSlashAsync', ctx);
    expect(spotifySearchApi.searchArtists).toHaveBeenCalledWith('Radiohead', 1);
    expect(result.content).toBe('https://open.spotify.com/artist/np');
  });

  it('returns error when recent track has no artist', async () => {
    const { service, lastFmRepository } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Airbag', artistName: '' }),
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'spotifyArtistSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('Could not determine artist details');
  });
});

describe('StreamingSlashCommands.appleMusicSlashAsync', () => {
  it('returns the Apple Music song URL when type is song', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: 'https://music.apple.com/us/album/airbag/123',
    });
    const ctx = mkContext({ interaction: { options: { getString: (n: string) => (n === 'query' ? 'airbag' : null) } } });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://music.apple.com/us/album/airbag/123');
  });

  it('defaults to song search when type option is missing', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: 'https://music.apple.com/us/album/song/456',
    });
    const ctx = mkContext({ interaction: { options: { getString: () => 'radiohead' } } });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(appleMusicService.searchSong).toHaveBeenCalledWith('radiohead');
    expect(result.content).toBe('https://music.apple.com/us/album/song/456');
  });

  it('falls back to album search when song not found', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (appleMusicService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue(
      'https://music.apple.com/us/album/fallback/789',
    );
    const ctx = mkContext({ interaction: { options: { getString: (n: string) => (n === 'query' ? 'ok computer' : null) } } });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(appleMusicService.searchAlbum).toHaveBeenCalledWith('ok computer');
    expect(result.content).toBe('https://music.apple.com/us/album/fallback/789');
  });

  it('returns NotFound when neither song nor album found', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (appleMusicService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const ctx = mkContext({ interaction: { options: { getString: () => 'nonexistent' } } });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns album URL when type is album', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue(
      'https://music.apple.com/us/album/ok-computer/999',
    );
    const ctx = mkContext({
      interaction: {
        options: {
          getString: (n: string) => (n === 'query' ? 'ok computer' : n === 'type' ? 'album' : null),
        },
      },
    });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(appleMusicService.searchAlbum).toHaveBeenCalledWith('ok computer');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://music.apple.com/us/album/ok-computer/999');
  });

  it('returns NotFound when album search returns null', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const ctx = mkContext({
      interaction: {
        options: {
          getString: (n: string) => (n === 'query' ? 'unknown album' : n === 'type' ? 'album' : null),
        },
      },
    });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns artist URL when type is artist', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue(
      'https://music.apple.com/us/artist/radiohead/111',
    );
    const ctx = mkContext({
      interaction: {
        options: {
          getString: (n: string) => (n === 'query' ? 'radiohead' : n === 'type' ? 'artist' : null),
        },
      },
    });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(appleMusicService.searchArtist).toHaveBeenCalledWith('radiohead');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://music.apple.com/us/artist/radiohead/111');
  });

  it('returns NotFound when artist search returns null', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const ctx = mkContext({
      interaction: {
        options: {
          getString: (n: string) => (n === 'query' ? 'unknown artist' : n === 'type' ? 'artist' : null),
        },
      },
    });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns error when user not registered and no query given', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  // The slash half of the Apple failure contract. `AppleMusicService` used to
  // `return null` on a 503, so a transient iTunes outage rendered here as
  // "No Apple Music release found" — a catalogue claim nobody had checked. The
  // service raises now, and these wrappers turn that into `Error` carrying the
  // provider's status. Mirrors the text half in
  // `textCommands/thirdParty/__tests__/streamingCommands.links.test.ts`, because
  // a half-fixed command family is a half-feature.

  it('renders a failed song search as Error, not as a release that is not on Apple', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('iTunes HTTP 503'));
    const ctx = mkContext({ interaction: { options: { getString: () => 'airbag' } } });

    const result = await call(service, 'appleMusicSlashAsync', ctx);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(result.embed.data.description).toContain('Apple Music search failed');
    expect(result.embed.data.description).toContain('iTunes HTTP 503');
    expect(result.embed.data.description).not.toContain('No Apple Music release found');
  });

  it('does not fall back to the album search after a failed song search', async () => {
    // A second provider call cannot rescue a failed first one, and running it
    // would let a 503 on the song rung still produce a confident album link.
    const { service, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('iTunes HTTP 503'));
    const ctx = mkContext({ interaction: { options: { getString: () => 'airbag' } } });

    await call(service, 'appleMusicSlashAsync', ctx);

    expect(appleMusicService.searchAlbum).not.toHaveBeenCalled();
  });

  it('renders a failed album search as Error in the album subcommand', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchAlbum as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('iTunes HTTP 500'));
    const ctx = mkContext({
      interaction: { options: { getString: (n: string) => (n === 'query' ? 'ok computer' : n === 'type' ? 'album' : null) } },
    });

    const result = await call(service, 'appleMusicSlashAsync', ctx);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(result.embed.data.description).toContain('Apple Music album search failed');
    expect(result.embed.data.description).not.toContain('No Apple Music album found');
  });

  it('renders a failed artist search as Error in the artist subcommand', async () => {
    const { service, appleMusicService } = build();
    (appleMusicService.searchArtist as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('iTunes HTTP 503'));
    const ctx = mkContext({
      interaction: { options: { getString: (n: string) => (n === 'query' ? 'radiohead' : n === 'type' ? 'artist' : null) } },
    });

    const result = await call(service, 'appleMusicSlashAsync', ctx);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(result.embed.data.description).toContain('Apple Music artist search failed');
    expect(result.embed.data.description).not.toContain('No Apple Music artist found');
  });

  it('renders a GENUINE miss as NotFound while a failure renders as Error', async () => {
    // Both directions. Asserting only the Error half would pass on a version
    // that returned Error for everything — the mirror-image defect.
    const { service: missService } = build();
    const miss = await call(
      missService,
      'appleMusicSlashAsync',
      mkContext({ interaction: { options: { getString: () => 'zzzznotatrack' } } }),
    );

    const { service: faultService, appleMusicService } = build();
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('iTunes HTTP 503'));
    const fault = await call(
      faultService,
      'appleMusicSlashAsync',
      mkContext({ interaction: { options: { getString: () => 'zzzznotatrack' } } }),
    );

    expect(miss.commandResponse).toBe(CommandResponse.NotFound);
    expect(fault.commandResponse).toBe(CommandResponse.Error);
  });

  it('resolves song query from nowPlaying recent track', async () => {
    const { service, lastFmRepository, appleMusicService } = build();
    (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkTrack({ name: 'Current Song', artistName: 'Current Artist', nowPlaying: true }),
    ]);
    (appleMusicService.searchSong as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: 'https://music.apple.com/us/album/current/1',
    });
    const ctx = mkContext({ interaction: { options: { getString: () => null } } });
    const result = await call(service, 'appleMusicSlashAsync', ctx);
    expect(appleMusicService.searchSong).toHaveBeenCalledWith('Current Artist Current Song');
    expect(result.content).toBe('https://music.apple.com/us/album/current/1');
  });
});
