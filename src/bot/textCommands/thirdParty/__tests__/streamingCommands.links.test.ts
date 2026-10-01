import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest';
import { StreamingCommands } from '@bot/textCommands/thirdParty/streamingCommands';
import { AppleMusicService } from '@bot/services/media/appleMusicService';
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
 *
 * THE APPLE HALF IS A REAL SERVICE, NOT A DOUBLE, ON PURPOSE
 * ---------------------------------------------------------
 * Every other block here builds an `appleMusicService` double. The failure
 * tests below wire the REAL `AppleMusicService` over a mocked `fetch` instead,
 * because the bug this file now guards lived in the real one and a double
 * cannot reproduce it: `AppleMusicService` used to `return null` on a 503, and
 * a double that throws on demand would have passed against that code forever.
 * Mocking the boundary rather than the collaborator is the only version of
 * these tests that can fail.
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

describe('.applemusic — now the same shape as .spotify, failure included', () => {
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

  it('reports a failed song search as an error, not as a release that is not on Apple', async () => {
    // This is the whole point of the consolidation. `AppleMusicService` used to
    // `return null` on a 503, so a transient outage rendered as
    // "No Apple Music release found" - a catalogue claim nobody had checked.
    // The service now raises `ITunesUnavailableError`, and these wrappers turn
    // that into `Error` carrying the provider's status.
    const { commands } = build({ throws: { song: new Error('iTunes HTTP 503') } });

    const result = await appleSong(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Apple Music search failed');
    expect(messageOf(result)).toContain('iTunes HTTP 503');
  });

  it('does not claim a release miss alongside a failed song search', async () => {
    // The opposite of the Spotify assertion at `:181`, and the one that would
    // catch a regression to the old behaviour. Reading this as a miss is the bug.
    const { commands } = build({ throws: { song: new Error('iTunes HTTP 503') } });

    const result = await appleSong(commands, ['airbag']);

    expect(messageOf(result)).not.toContain('No Apple Music release found');
  });

  it('does not fall back to the album search after a failed song search', async () => {
    // A second provider call cannot rescue a failed first one, and letting it
    // run would mean a 503 on the song rung could still produce a confident
    // album link - the wrong-but-plausible answer this file exists to prevent.
    const { commands, appleMusicService } = build({ throws: { song: new Error('iTunes HTTP 503') } });

    await appleSong(commands, ['airbag']);

    expect(appleMusicService.searchAlbum).not.toHaveBeenCalled();
  });

  it('reports a failed ALBUM fallback as an error, distinct from a song miss', async () => {
    // The fallback rung has its own failure, and it must not be reported as
    // "no release found" either.
    const { commands } = build({ song: null, throws: { albumUrl: new Error('iTunes HTTP 500') } });

    const result = await appleSong(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Apple Music album search failed');
    expect(messageOf(result)).toContain('iTunes HTTP 500');
  });

  it('reports a failed album search as an error in the album command', async () => {
    const { commands } = build({ throws: { albumUrl: new Error('iTunes HTTP 503') } });

    const result = await appleAlbum(commands, ['ok computer']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Apple Music album search failed');
    expect(messageOf(result)).not.toContain('No Apple Music album link');
  });

  it('reports a failed artist search as an error in the artist command', async () => {
    const { commands } = build({ throws: { artistUrl: new Error('iTunes HTTP 503') } });

    const result = await appleArtist(commands, ['radiohead']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Apple Music artist search failed');
    expect(messageOf(result)).not.toContain('No Apple Music artist link');
  });

  it('renders a GENUINE miss as NotFound while a failure renders as Error', async () => {
    // Both directions of the fix, at the layer the user actually sees. A test
    // that only asserted the Error half would pass on a version that returned
    // Error for everything, which is the mirror-image defect.
    const miss = await appleSong(build({ song: null, albumUrl: null }).commands, ['zzzz']);
    const fault = await appleSong(build({ throws: { song: new Error('iTunes HTTP 503') } }).commands, ['zzzz']);

    expect(miss.commandResponse).toBe(CommandResponse.NotFound);
    expect(fault.commandResponse).toBe(CommandResponse.Error);
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

describe('.applemusic over the REAL AppleMusicService, so a swallowed 503 cannot hide', () => {
  // Everything above this block feeds the command a double. A double that
  // throws proves the command handles a throw; it cannot prove the real service
  // ever throws. The bug was real code swallowing a 503 and returning null, so
  // these tests hold the real service and mock only `fetch`.

  let fetchMock: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  /** The same command object, with the real service substituted in. */
  const withRealApple = (): StreamingCommands => {
    const base = build();
    return new StreamingCommands(
      base.userService as never,
      base.spotifySearchApi as never,
      new AppleMusicService() as never,
      { getPrefix: vi.fn(async () => '.') } as never,
      base.lastFmRepository as never,
      { getColorFromImageUrl: vi.fn(async () => 0x445566) } as never,
    );
  };

  it('renders an iTunes 503 as an Error, not as "no Apple Music release found"', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as never);

    const result = await appleSong(withRealApple(), ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Apple Music search failed');
    expect(messageOf(result)).toContain('iTunes HTTP 503');
    expect(messageOf(result)).not.toContain('No Apple Music release found');
  });

  it('still renders a GENUINE miss as NotFound through the real service', async () => {
    // The other direction, and the one a lazy fix breaks. `return null` for
    // everything passes the 503 test above and lies here.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) } as never);

    const result = await appleSong(withRealApple(), ['zzzznotatrack']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('renders a 500 from the real service as an Error in the album command', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as never);

    const result = await appleAlbum(withRealApple(), ['ok computer']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('iTunes HTTP 500');
  });

  it('renders a 503 from the real service as an Error in the artist command', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as never);

    const result = await appleArtist(withRealApple(), ['radiohead']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Apple Music artist search failed');
    expect(messageOf(result)).not.toContain('No Apple Music artist link');
  });

  it('posts the real URL when the real service finds something', async () => {
    // Proves the consolidation did not break the success path: the real service
    // now reads one row through `AppleMusicSearchApi` rather than its own fetch.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ trackName: 'Airbag', artistName: 'Radiohead', trackViewUrl: 'https://music.apple.com/song/9' }],
      }),
    } as never);

    const result = await appleSong(withRealApple(), ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(result.content).toBe('https://music.apple.com/song/9');
  });

  it('makes exactly two requests for a miss, not one per provider in the bot', async () => {
    // Song rung plus the album fallback, both through the one iTunes client.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) } as never);

    await appleSong(withRealApple(), ['zzzz']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
