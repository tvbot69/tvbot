import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamingCommands } from './streamingCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';

/**
 * The six link commands, and what they do when the search provider disagrees.
 *
 * A link is the whole output here, so the two failure shapes are the only ones
 * that matter and they point in opposite directions:
 *
 *  - **A throw must render as an error.** A failed search that produced a
 *    NotFound would say "this song is not on Spotify", which is a claim about
 *    the catalogue that nobody checked.
 *  - **A miss must render as a NotFound.** Falling through to an empty string
 *    would post a blank message, and posting the first row of an unrelated
 *    result set would be worse.
 *
 * Two behaviours in here are easy to break without noticing:
 *
 *  - a result row with NO `external_urls.spotify` is not a hit. Reading
 *    `external_urls` instead of `external_urls.spotify` turns it into one, and
 *    the user gets a message whose content is `undefined`.
 *  - `.spotify album …` and `.spotify artist …` are a TEXT-ONLY dispatch: the
 *    slash twin has typed subcommands and no such prefix routing, so the two
 *    families genuinely differ here and the test names that.
 */

const user = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const recent = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Airbag',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: false,
  ...over,
});

const spotifyUrl = (path: string) => ({ external_urls: { spotify: `https://open.spotify.com/${path}` } });

type Over = {
  caller?: User | null;
  recents?: RecentTrack[];
  tracks?: unknown[];
  albums?: unknown[];
  artists?: unknown[];
  song?: { url?: string } | null;
  albumUrl?: string | null;
  artistUrl?: string | null;
  throws?: Record<string, unknown>;
};

const build = (over: Over = {}) => {
  const boom = (key: string) => (over.throws && key in over.throws ? over.throws[key] : undefined);
  const guard = async <T>(key: string, value: T): Promise<T> => {
    const err = boom(key);
    if (err) throw err;
    return value;
  };

  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? user() : over.caller)),
  };
  const spotifySearchApi = {
    searchTracks: vi.fn(async () => guard('tracks', (over.tracks ?? []) as unknown[])),
    searchAlbums: vi.fn(async () => guard('albums', (over.albums ?? []) as unknown[])),
    searchArtists: vi.fn(async () => guard('artists', (over.artists ?? []) as unknown[])),
  };
  const appleMusicService = {
    searchSong: vi.fn(async () => guard('song', (over.song === undefined ? null : over.song) as { url?: string } | null)),
    searchAlbum: vi.fn(async () => guard('albumUrl', (over.albumUrl === undefined ? null : over.albumUrl) as string | null)),
    searchArtist: vi.fn(async () => guard('artistUrl', (over.artistUrl === undefined ? null : over.artistUrl) as string | null)),
  };
  const prefixService = { getPrefix: vi.fn(async () => '.') };
  const lastFmRepository = {
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) => (over.recents ?? [recent()]) as RecentTrack[]),
  };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x445566) };

  const commands = new StreamingCommands(
    userService as never,
    spotifySearchApi as never,
    appleMusicService as never,
    prefixService as never,
    lastFmRepository as never,
    colorService as never,
  );
  return { commands, userService, spotifySearchApi, appleMusicService, lastFmRepository };
};

type Handled = { commandResponse: CommandResponse; content?: string; embed: { data: { description?: string } } };

const call = (c: StreamingCommands, name: string, args: string[], context: ContextModel = ctx()) =>
  (c as unknown as Record<string, (...a: unknown[]) => Promise<Handled>>)[name]!.bind(c)(context, args);

const spotifyTrack = (c: StreamingCommands, args: string[]) => call(c, 'spotifyTrackAsync', args);
const spotifyAlbum = (c: StreamingCommands, args: string[]) => call(c, 'spotifyAlbumAsync', args);
const spotifyArtist = (c: StreamingCommands, args: string[]) => call(c, 'spotifyArtistAsync', args);
const appleSong = (c: StreamingCommands, args: string[]) => call(c, 'appleMusicAsync', args);
const appleAlbum = (c: StreamingCommands, args: string[]) => call(c, 'appleMusicAlbumAsync', args);
const appleArtist = (c: StreamingCommands, args: string[]) => call(c, 'appleMusicArtistAsync', args);

const messageOf = (r: Handled): string => r.embed.data.description ?? '';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('.spotify — a hit, a fallback, and a miss', () => {
  it('posts the track URL when there is one', async () => {
    const { commands, spotifySearchApi } = build({ tracks: [spotifyUrl('track/abc')] });

    const result = await spotifyTrack(commands, ['airbag']);

    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('airbag', 1);
    expect(result.content).toBe('https://open.spotify.com/track/abc');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
  });

  it('falls back to the album search when no track matches', async () => {
    const { commands, spotifySearchApi } = build({ tracks: [], albums: [spotifyUrl('album/xyz')] });

    const result = await spotifyTrack(commands, ['airbag']);

    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('airbag', 1);
    expect(result.content).toBe('https://open.spotify.com/album/xyz');
  });

  it('reports a miss on both searches rather than posting an empty message', async () => {
    const { commands } = build({ tracks: [], albums: [] });

    const result = await spotifyTrack(commands, ['zzzznotatrack']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.content).toBeUndefined();
    expect(messageOf(result)).toContain('zzzznotatrack');
  });

  it('does not treat a row without a spotify URL as a hit', async () => {
    // A shape the provider really returns: a track with no external URLs yet.
    // Reading `external_urls` instead of `external_urls.spotify` would post a
    // message whose content is `[object Object]` — or undefined.
    const { commands, spotifySearchApi } = build({ tracks: [{ external_urls: {} }], albums: [] });

    const result = await spotifyTrack(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(spotifySearchApi.searchAlbums).toHaveBeenCalled();
  });

  it('reports a failed search as an error, not as a song that is not on Spotify', async () => {
    const { commands } = build({ throws: { tracks: new Error('Spotify 503') } });

    const result = await spotifyTrack(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Spotify search failed');
    expect(messageOf(result)).toContain('Spotify 503');
  });

  it('does not claim a catalogue miss alongside a failed search', async () => {
    const { commands } = build({ throws: { tracks: new Error('Spotify 503') } });

    const result = await spotifyTrack(commands, ['airbag']);

    expect(messageOf(result)).not.toContain('No Spotify link found');
  });
});

describe('.spotifyalbum and .spotifyartist never cross over', () => {
  it('searches albums only', async () => {
    const { commands, spotifySearchApi } = build({ albums: [spotifyUrl('album/xyz')] });

    const result = await spotifyAlbum(commands, ['ok computer']);

    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('ok computer', 1);
    expect(spotifySearchApi.searchTracks).not.toHaveBeenCalled();
    expect(result.content).toBe('https://open.spotify.com/album/xyz');
  });

  it('searches artists only', async () => {
    const { commands, spotifySearchApi } = build({ artists: [spotifyUrl('artist/qqq')] });

    const result = await spotifyArtist(commands, ['radiohead']);

    expect(spotifySearchApi.searchArtists).toHaveBeenCalledWith('radiohead', 1);
    expect(spotifySearchApi.searchTracks).not.toHaveBeenCalled();
    expect(result.content).toBe('https://open.spotify.com/artist/qqq');
  });

  it('reports a failed album search as an error', async () => {
    const { commands } = build({ throws: { albums: new Error('Spotify 503') } });

    const result = await spotifyAlbum(commands, ['ok computer']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Spotify album search failed');
  });

  it('reports a failed artist search as an error', async () => {
    const { commands } = build({ throws: { artists: new Error('Spotify 503') } });

    const result = await spotifyArtist(commands, ['radiohead']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Spotify artist search failed');
  });

  it('reports an album and an artist miss distinctly from a track miss', async () => {
    const { commands } = build();

    expect((await spotifyAlbum(commands, ['zzzz'])).embed.data.description).toContain('No Spotify album link');
    expect((await spotifyArtist(commands, ['zzzz'])).embed.data.description).toContain('No Spotify artist link');
  });
});

describe('.spotify — the text-only `album` / `artist` prefix dispatch', () => {
  it('routes "album …" to the album search and never to the track search', async () => {
    const { commands, spotifySearchApi } = build({ albums: [spotifyUrl('album/xyz')], tracks: [spotifyUrl('track/abc')] });

    const result = await spotifyTrack(commands, ['album ok computer']);

    expect(spotifySearchApi.searchTracks).not.toHaveBeenCalled();
    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('ok computer', 1);
    expect(result.content).toBe('https://open.spotify.com/album/xyz');
  });

  it('routes "artist …" to the artist search', async () => {
    const { commands, spotifySearchApi } = build({ artists: [spotifyUrl('artist/qqq')] });

    await spotifyTrack(commands, ['artist radiohead']);

    expect(spotifySearchApi.searchArtists).toHaveBeenCalledWith('radiohead', 1);
    expect(spotifySearchApi.searchTracks).not.toHaveBeenCalled();
  });

  it('matches the prefix case-insensitively', async () => {
    const { commands, spotifySearchApi } = build({ albums: [spotifyUrl('album/xyz')] });

    await spotifyTrack(commands, ['ALBUM ok computer']);

    expect(spotifySearchApi.searchAlbums).toHaveBeenCalledWith('ok computer', 1);
  });

  it('does not treat a track that merely starts with the letters as a dispatch', async () => {
    // "albums by someone" is a search string, not the word ALBUM plus a query.
    // `startsWith('album ')` with the space is what keeps them apart.
    const { commands, spotifySearchApi } = build({ tracks: [spotifyUrl('track/abc')] });

    await spotifyTrack(commands, ['albums by someone']);

    expect(spotifySearchApi.searchTracks).toHaveBeenCalledWith('albums by someone', 1);
    expect(spotifySearchApi.searchAlbums).not.toHaveBeenCalled();
  });
});

describe('.applemusic — the same shape, without the try/catch', () => {
  it('posts the song URL when there is one', async () => {
    const { commands, appleMusicService } = build({ song: { url: 'https://music.apple.com/song/1' } });

    const result = await appleSong(commands, ['airbag']);

    expect(appleMusicService.searchSong).toHaveBeenCalledWith('airbag');
    expect(result.content).toBe('https://music.apple.com/song/1');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
  });

  it('falls back to the album search when no song matches', async () => {
    const { commands, appleMusicService } = build({ song: null, albumUrl: 'https://music.apple.com/album/2' });

    const result = await appleSong(commands, ['airbag']);

    expect(appleMusicService.searchAlbum).toHaveBeenCalledWith('airbag');
    expect(result.content).toBe('https://music.apple.com/album/2');
  });

  it('reports a release miss rather than posting an empty message', async () => {
    const { commands } = build({ song: null, albumUrl: null });

    const result = await appleSong(commands, ['zzzznotatrack']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.content).toBeUndefined();
  });

  it('does not treat a result with no url as a hit', async () => {
    const { commands } = build({ song: { url: undefined }, albumUrl: null });

    const result = await appleSong(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('CURRENT BEHAVIOUR: a failed Apple Music search propagates instead of rendering here', async () => {
    // NOT endorsed, and the sharpest asymmetry in the file. The three Spotify
    // commands wrap their search and answer `Error` with the provider's message;
    // the three Apple Music commands do not, so a throw reaches the command
    // boundary and the user gets its generic failure. Still better than a
    // "no link found" lie, and pinned so fixing it is a visible diff.
    const { commands } = build({ throws: { song: new Error('Apple Music 500') } });

    await expect(appleSong(commands, ['airbag'])).rejects.toThrow(/Apple Music 500/);
  });

  it('posts an album URL for the album command', async () => {
    const { commands, appleMusicService } = build({ albumUrl: 'https://music.apple.com/album/2' });

    const result = await appleAlbum(commands, ['ok computer']);

    expect(appleMusicService.searchAlbum).toHaveBeenCalledWith('ok computer');
    expect(result.content).toBe('https://music.apple.com/album/2');
  });

  it('posts an artist URL for the artist command', async () => {
    const { commands, appleMusicService } = build({ artistUrl: 'https://music.apple.com/artist/3' });

    const result = await appleArtist(commands, ['radiohead']);

    expect(appleMusicService.searchArtist).toHaveBeenCalledWith('radiohead');
    expect(result.content).toBe('https://music.apple.com/artist/3');
  });

  it('reports an album miss and an artist miss distinctly', async () => {
    const { commands } = build();

    expect((await appleAlbum(commands, ['zzzz'])).embed.data.description).toContain('No Apple Music album link');
    expect((await appleArtist(commands, ['zzzz'])).embed.data.description).toContain('No Apple Music artist link');
  });

  it('routes the text-only "album" and "artist" prefixes to their own bodies', async () => {
    const { commands, appleMusicService } = build({ albumUrl: 'https://music.apple.com/album/2', artistUrl: 'https://music.apple.com/artist/3' });

    await appleSong(commands, ['album ok computer']);
    await appleSong(commands, ['artist radiohead']);

    expect(appleMusicService.searchAlbum).toHaveBeenCalledWith('ok computer');
    expect(appleMusicService.searchArtist).toHaveBeenCalledWith('radiohead');
    expect(appleMusicService.searchSong).not.toHaveBeenCalled();
  });
});

describe('every link command has a trigger that reaches it', () => {
  it('routes each trigger to the body that answers for it', async () => {
    const { commands, spotifySearchApi, appleMusicService } = build({
      tracks: [spotifyUrl('track/abc')],
      albums: [spotifyUrl('album/xyz')],
      artists: [spotifyUrl('artist/qqq')],
      song: { url: 'https://music.apple.com/song/1' },
      albumUrl: 'https://music.apple.com/album/2',
      artistUrl: 'https://music.apple.com/artist/3',
    });

    const byName = (n: string) => commands.commands.find((c) => c.name === n)!;
    await byName('spotify').executeAsync(ctx(), ['airbag']);
    await byName('spotifyalbum').executeAsync(ctx(), ['ok computer']);
    await byName('spotifyartist').executeAsync(ctx(), ['radiohead']);
    await byName('applemusic').executeAsync(ctx(), ['airbag']);
    await byName('applemusicalbum').executeAsync(ctx(), ['ok computer']);
    await byName('applemusicartist').executeAsync(ctx(), ['radiohead']);

    expect(spotifySearchApi.searchTracks).toHaveBeenCalledTimes(1);
    expect(appleMusicService.searchSong).toHaveBeenCalledTimes(1);
  });

  it('surfaces a resolver refusal through the trigger unchanged', async () => {
    const { commands, spotifySearchApi } = build({ caller: null });

    const cmd = commands.commands.find((c) => c.name === 'spotify')!;
    const result = (await cmd.executeAsync(ctx(), [])) as unknown as Handled;

    // An unlinked account must not reach the provider at all.
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(spotifySearchApi.searchTracks).not.toHaveBeenCalled();
  });
});
