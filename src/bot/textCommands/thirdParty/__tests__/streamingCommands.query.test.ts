import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamingCommands } from '@bot/textCommands/thirdParty/streamingCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';

/**
 * The three query resolvers behind `.spotify` / `.spotifyalbum` /
 * `.spotifyartist` / `.applemusic` and their album and artist variants.
 *
 * All six triggers are the same decision: what string do we hand the search
 * provider? Six ways to get it wrong, and three of them produce a link rather
 * than an error, which is the dangerous kind:
 *
 *  1. **A failed Last.fm read must not become "no recent tracks".** The catch
 *     block answers `Error` and names Last.fm. `NotFound` would be the lie —
 *     it is exactly what a listener with an empty profile gets, so the user
 *     would be told they have no recent tracks when in fact nobody asked.
 *  2. **The NOW-PLAYING track is preferred** over the most recent completed
 *     one. `.spotify` with no argument means "what am I listening to", and
 *     `recents[0]` is the previous song.
 *  3. **A partial scrobble degrades to a narrower query rather than nothing.**
 *     A track with no album still yields an artist search, because a dangling
 *     space and an empty string are both queries Last.fm answers with something
 *     unrelated.
 *
 * The explicit-argument short circuit is asserted too: when the user typed a
 * query there is no Last.fm read at all, because a provider lookup they did not
 * ask for can only degrade the answer.
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

const track = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Airbag',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: false,
  ...over,
});

type Over = {
  caller?: User | null;
  recents?: RecentTrack[] | null;
  recentsThrow?: unknown;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? user() : over.caller)),
  };
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
  const prefixService = { getPrefix: vi.fn(async () => '.') };
  const lastFmRepository = {
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) => {
      if (over.recentsThrow) throw over.recentsThrow;
      return (over.recents === undefined ? [track()] : over.recents) as RecentTrack[];
    }),
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
  return { commands, userService, spotifySearchApi, appleMusicService, prefixService, lastFmRepository };
};

type Resolved = { query: string } | { errorResponse: { commandResponse: CommandResponse; embed: { data: { description?: string } } } };

const resolver = (c: StreamingCommands, name: string) =>
  (c as unknown as Record<string, (...a: unknown[]) => Promise<Resolved>>)[name]!.bind(c);

const trackQuery = (c: StreamingCommands, args: string[]) => resolver(c, 'resolveQuery')(ctx(), args, 'spotify');
const albumQuery = (c: StreamingCommands, args: string[]) => resolver(c, 'resolveAlbumQuery')(ctx(), args, 'spotifyalbum');
const artistQuery = (c: StreamingCommands, args: string[]) => resolver(c, 'resolveArtistQuery')(ctx(), args, 'spotifyartist');

const messageOf = (r: Resolved): string =>
  'errorResponse' in r ? (r.errorResponse.embed.data.description ?? '') : '';
const codeOf = (r: Resolved): CommandResponse | undefined =>
  'errorResponse' in r ? r.errorResponse.commandResponse : undefined;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('an explicit argument short-circuits every resolver', () => {
  it('uses the user’s own words for a track search', async () => {
    const { commands, lastFmRepository } = build();

    const result = await trackQuery(commands, ['weird', 'fishes']);

    expect(result).toEqual({ query: 'weird fishes' });
    // A provider lookup the user did not ask for can only degrade the answer.
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('uses the user’s own words for an album search', async () => {
    const { commands, lastFmRepository } = build();

    expect(await albumQuery(commands, ['ok computer'])).toEqual({ query: 'ok computer' });
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('uses the user’s own words for an artist search', async () => {
    const { commands, lastFmRepository } = build();

    expect(await artistQuery(commands, ['radiohead'])).toEqual({ query: 'radiohead' });
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('treats an argument list of only spaces as no argument at all', async () => {
    const { commands, lastFmRepository } = build();

    const result = await trackQuery(commands, ['   ']);

    // Falling through to Last.fm here is correct: there is no query to use.
    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalled();
    expect(result).toEqual({ query: 'Radiohead Airbag' });
  });
});

describe('an unlinked account is refused before any provider call', () => {
  it('refuses with the canonical register message for a track search', async () => {
    const { commands, lastFmRepository } = build({ caller: null });

    const result = await trackQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.NotFound);
    expect(messageOf(result)).toContain('.register');
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses with the canonical register message for an album search', async () => {
    const { commands } = build({ caller: null });

    const result = await albumQuery(commands, []);

    expect(messageOf(result)).toContain('.register');
  });

  it('refuses with the canonical register message for an artist search', async () => {
    const { commands } = build({ caller: null });

    const result = await artistQuery(commands, []);

    expect(messageOf(result)).toContain('.register');
  });

  it('treats a user row with a BLANK Last.fm name as unlinked', async () => {
    // `userNameLastFm` is only ever an empty string when a row exists without a
    // name. Passing that through would build a query out of nothing and blame
    // the provider for finding nothing.
    const { commands, lastFmRepository } = build({ caller: user({ userNameLastFm: '' }) });

    const result = await trackQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.NotFound);
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });
});

describe('substituting the caller’s now-playing track', () => {
  it('prefers the now-playing row over the most recent completed one', async () => {
    const { commands } = build({
      recents: [
        track({ name: 'Karma Police', nowPlaying: false }),
        track({ name: 'Airbag', nowPlaying: true }),
      ],
    });

    // `.spotify` with no argument means "what am I listening to right now", and
    // recents[0] is the PREVIOUS song. Getting this backwards returns a valid
    // link to the wrong track, with nothing on screen to catch it.
    expect(await trackQuery(commands, [])).toEqual({ query: 'Radiohead Airbag' });
  });

  it('falls back to the first row when nothing is playing now', async () => {
    const { commands } = build({ recents: [track({ name: 'Karma Police', nowPlaying: false })] });

    expect(await trackQuery(commands, [])).toEqual({ query: 'Radiohead Karma Police' });
  });

  it('asks for two rows, because the now-playing one is not always first', async () => {
    const { commands, lastFmRepository } = build();

    await trackQuery(commands, []);

    // Asking for one row makes the `find(nowPlaying)` above unreachable.
    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 2, 1, undefined, 'SK');
  });

  it('sends the session key so a private library is not silently empty', async () => {
    const { commands, lastFmRepository } = build({ caller: user({ sessionKey: 'PRIVATE' }) });

    await trackQuery(commands, []);

    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 2, 1, undefined, 'PRIVATE');
  });

  it('sends undefined rather than null for an account with no key', async () => {
    const { commands, lastFmRepository } = build({ caller: user({ sessionKey: undefined }) });

    await trackQuery(commands, []);

    const sessionKey = (lastFmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mock.calls[0]![4];
    expect(sessionKey).toBeUndefined();
  });
});

describe('an empty profile is a real answer', () => {
  it('reports no recent tracks by Last.fm name', async () => {
    const { commands } = build({ recents: [] });

    const result = await trackQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.NotFound);
    expect(messageOf(result)).toContain('Alpha');
    expect(messageOf(result)).toContain('.spotify');
  });

  it('reports a null list the same way', async () => {
    const { commands } = build({ recents: null });

    const result = await trackQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.NotFound);
  });

  it('reports a scrobble with no artist and no title as undeterminable', async () => {
    const { commands } = build({ recents: [track({ name: '', artistName: '' })] });

    const result = await trackQuery(commands, []);

    // An empty query is worse than no query: the provider would answer with
    // something unrelated and the user would get a confident wrong link.
    expect(codeOf(result)).toBe(CommandResponse.NotFound);
    expect(messageOf(result)).toContain('Could not determine track details');
  });

  it('still builds a query from whichever half of the scrobble exists', async () => {
    const { commands } = build({ recents: [track({ name: '', artistName: 'Radiohead' })] });

    expect(await trackQuery(commands, [])).toEqual({ query: 'Radiohead' });
  });
});

describe('the album and artist resolvers degrade to a narrower query, not to nothing', () => {
  it('combines artist and album when the scrobble has both', async () => {
    const { commands } = build();

    expect(await albumQuery(commands, [])).toEqual({ query: 'Radiohead OK Computer' });
  });

  it('drops the album rather than sending a trailing space', async () => {
    const { commands } = build({ recents: [track({ albumName: '' })] });

    // `"Radiohead "` and `"Radiohead"` are the same string after the trim, but
    // only the second is a deliberate query, and the guard is what makes the
    // difference visible in a test.
    expect(await albumQuery(commands, [])).toEqual({ query: 'Radiohead' });
  });

  it('refuses an album query when the scrobble has neither', async () => {
    const { commands } = build({ recents: [track({ artistName: '', albumName: '' })] });

    const result = await albumQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.NotFound);
    expect(messageOf(result)).toContain('Could not determine album details');
    expect(messageOf(result)).toContain('.spotifyalbum');
  });

  it('uses only the artist for an artist search', async () => {
    const { commands } = build();

    expect(await artistQuery(commands, [])).toEqual({ query: 'Radiohead' });
  });

  it('refuses an artist query when the scrobble has no artist', async () => {
    const { commands } = build({ recents: [track({ artistName: '' })] });

    const result = await artistQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.NotFound);
    expect(messageOf(result)).toContain('Could not determine artist details');
    expect(messageOf(result)).toContain('.spotifyartist');
  });

  it('is not fooled by an album that exists on a track with no artist', async () => {
    // The album resolver can still build a query from an album alone; the
    // artist resolver cannot. The two guards are genuinely different.
    const { commands } = build({ recents: [track({ artistName: '', albumName: 'OK Computer' })] });

    expect(await albumQuery(commands, [])).toEqual({ query: 'OK Computer' });
    expect(codeOf(await artistQuery(commands, []))).toBe(CommandResponse.NotFound);
  });
});

describe('a failed Last.fm read is never "you have no recent tracks"', () => {
  const lastFmDown = () => new LastFmUnavailableError('user.getrecenttracks', new Error('Last.fm 5xx'));

  it('reports a Last.fm outage as an error naming Last.fm', async () => {
    const { commands } = build({ recentsThrow: lastFmDown() });

    const result = await trackQuery(commands, []);

    // NotFound is exactly what an empty profile renders as, so choosing it here
    // would be indistinguishable from the truth.
    expect(codeOf(result)).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('Last.fm');
  });

  it('passes the provider’s own message through so the user is not left guessing', async () => {
    const { commands } = build({ recentsThrow: lastFmDown() });

    const result = await trackQuery(commands, []);

    expect(messageOf(result)).toContain('Last.fm 5xx');
  });

  it('does the same for the album and artist resolvers', async () => {
    const { commands } = build({ recentsThrow: lastFmDown() });

    expect(codeOf(await albumQuery(commands, []))).toBe(CommandResponse.Error);
    expect(codeOf(await artistQuery(commands, []))).toBe(CommandResponse.Error);
  });

  it('does not claim an empty profile alongside the error', async () => {
    const { commands } = build({ recentsThrow: lastFmDown() });

    const result = await trackQuery(commands, []);

    expect(messageOf(result)).not.toContain('No recent tracks found');
  });

  it('survives a thrown non-Error without rendering "[object Object]"', async () => {
    const { commands } = build({ recentsThrow: { code: 8, message: 'read timeout' } });

    const result = await trackQuery(commands, []);

    expect(codeOf(result)).toBe(CommandResponse.Error);
    expect(messageOf(result)).toContain('read timeout');
  });
});

describe('the streaming triggers are six names over three resolvers', () => {
  it('gives every trigger a unique name', () => {
    const { commands } = build();
    const triggers = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('registers the documented names and aliases', () => {
    const { commands } = build();
    const byName = (n: string) => commands.commands.find((c) => c.name === n)!;
    expect(byName('spotify').aliases).toEqual(['sp', 'spotifyfind', 'spotifysearch']);
    expect(byName('spotifyalbum').aliases).toEqual(['spalbum', 'salbum']);
    expect(byName('spotifyartist').aliases).toEqual(['spartist', 'sartist']);
    expect(byName('applemusic').aliases).toEqual(['am', 'apple']);
    expect(byName('applemusicalbum').aliases).toEqual(['amalbum', 'applealbum']);
    expect(byName('applemusicartist').aliases).toEqual(['amartist']);
  });

  it('never claims `remove`, which belongs to the queue commands', () => {
    const { commands } = build();
    expect(commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])])).not.toContain('remove');
  });
});
