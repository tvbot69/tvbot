import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TrackCommands } from './trackCommands';
import { TrackBuilders } from '@bot/builders/trackBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';

/**
 * `.love` / `.unlove` / `.loved` / `.scrobble` — the four commands that WRITE to
 * someone’s Last.fm account.
 *
 * That makes them the sharpest trust boundary in the bot: three of the four
 * mutate remote state on the user’s behalf, and every wrong-input path here
 * either talks the bot into a write nobody asked for or reports a write that
 * never happened.
 *
 * The branches that matter, in the order they can hurt:
 *
 *  - **no session key.** Without one Last.fm would reject the write anyway; the
 *    command says so instead, and crucially it must say so BEFORE resolving a
 *    track, or a user with no authorisation gets "Could not find track
 *    matching …" for a track they named perfectly well.
 *  - **a refused write.** `loveTrack` / `unloveTrack` / `scrobbleTrack` return
 *    a boolean and the boolean is the only evidence the write happened. The
 *    tests assert the success card is NOT built on `false`, in all three.
 *  - **an empty `.scrobble`.** With no arguments the command answers with usage
 *    and must not scrobble the caller’s now-playing track. That would be a
 *    silent, irreversible write triggered by a bare word.
 *  - **`.love list`.** The word `list` is a mode switch, so `.love list` is the
 *    loved list, not a search for a track called "list".
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
    accentColor: 0x445566,
    message: {
      channelId: 'C1',
      author: { id: '111', username: 'caller', displayName: 'Caller' },
      member: { displayName: 'Caller' },
      guild: {
        name: 'Test Guild',
        members: { cache: new Map(), fetch: vi.fn(async () => null) },
      },
    },
    ...over,
  }) as unknown as ContextModel;

const recent = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Airbag',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: false,
  ...over,
});

type Over = {
  caller?: User | null;
  mentioned?: User | null;
  recents?: RecentTrack[] | null;
  searchHits?: unknown[];
  lovedResult?: unknown;
  lovedFails?: boolean;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...a: unknown[]) => {
      const id = a[0] as string;
      if (id !== '111') return (over.mentioned ?? null) as User | null;
      return over.caller === undefined ? user() : over.caller;
    }),
  };
  const trackService = { searchTrack: vi.fn(async () => null) };
  const trackDetailsService = { getDetails: vi.fn(async () => null) };
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) =>
      (over.recents === undefined ? [recent()] : over.recents) as RecentTrack[],
    ),
    searchTracks: vi.fn(async (..._a: unknown[]) => (over.searchHits ?? []) as unknown[]),
    loveTrack: vi.fn(async (..._a: unknown[]) => over.lovedFails !== true),
    unloveTrack: vi.fn(async (..._a: unknown[]) => over.lovedFails !== true),
    scrobbleTrack: vi.fn(async (..._a: unknown[]) => over.lovedFails !== true),
    getLovedTracks: vi.fn(async (..._a: unknown[]) =>
      (over.lovedResult === undefined
        ? { tracks: [{ artistName: 'Radiohead', name: 'Airbag', playcount: 1 }], total: 1 }
        : over.lovedResult) as { tracks: unknown[]; total: number },
    ),
  };
  const updateService = { updateUser: vi.fn(async () => undefined) };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x112233) };

  const commands = new TrackCommands(
    userService as never,
    trackService as never,
    trackDetailsService as never,
    lastfmRepository as never,
    updateService as never,
    undefined,
    colorService as never,
  );
  return { commands, userService, lastfmRepository, colorService };
};

const priv = (c: TrackCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>>;

const love = (c: TrackCommands, args: string[], context: ContextModel = ctx()) =>
  priv(c)['loveAsync']!.bind(c)(context, args);
const unlove = (c: TrackCommands, args: string[], context: ContextModel = ctx()) =>
  priv(c)['unloveAsync']!.bind(c)(context, args);
const loved = (c: TrackCommands, args: string[], context: ContextModel = ctx()) =>
  priv(c)['lovedAsync']!.bind(c)(context, args);
const scrobble = (c: TrackCommands, args: string[], context: ContextModel = ctx()) =>
  priv(c)['scrobbleAsync']!.bind(c)(context, args);

const desc = (r: unknown): string => (r as { embed: { data: { description?: string } } }).embed.data.description ?? '';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(TrackBuilders, 'buildLoveResponse').mockReturnValue({ marker: 'love' } as never);
  vi.spyOn(TrackBuilders, 'buildUnloveResponse').mockReturnValue({ marker: 'unlove' } as never);
  vi.spyOn(TrackBuilders, 'buildLovedTracksResponse').mockReturnValue({ marker: 'loved' } as never);
  vi.spyOn(TrackBuilders, 'buildScrobbleResponse').mockReturnValue({ marker: 'scrobbled' } as never);
});

describe('.love — authorisation is checked before the track is even looked up', () => {
  it('tells an unauthenticated user to log in, and writes nothing', async () => {
    const { commands, lastfmRepository } = build({ caller: user({ sessionKey: undefined }) });

    const result = await love(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
    expect(desc(result)).toContain('.login');
    // A search here would end in "could not find track matching …" for a track
    // the user named perfectly well, sending them hunting for a typo.
    expect(lastfmRepository.searchTracks).not.toHaveBeenCalled();
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await love(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });
});

describe('.love — resolving WHICH track to love', () => {
  it('splits "Artist | Track"', async () => {
    const { commands, lastfmRepository } = build();

    await love(commands, ['Radiohead', '|', 'Airbag']);

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'SK');
  });

  it('splits "Track by Artist", whatever the case', async () => {
    const { commands, lastfmRepository } = build();

    await love(commands, ['Airbag', 'by', 'Radiohead']);

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'SK');
  });

  it('searches Last.fm for a bare query and takes the first hit', async () => {
    const { commands, lastfmRepository } = build({
      searchHits: [{ artistName: 'Radiohead', name: 'Airbag' }],
    });

    await love(commands, ['airbag']);

    expect(lastfmRepository.searchTracks).toHaveBeenCalledWith('airbag');
    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'SK');
  });

  it('loves the most recent track when nothing is named', async () => {
    const { commands, lastfmRepository } = build();

    await love(commands, []);

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 1, 1, undefined, 'SK');
    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'SK');
  });

  it('reports an empty recent history instead of loving an arbitrary track', async () => {
    const { commands, lastfmRepository } = build({ recents: [] });

    const result = await love(commands, []);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('reports a search that matched nothing instead of loving the raw text', async () => {
    const { commands, lastfmRepository } = build({ searchHits: [] });

    const result = await love(commands, ['zzzznotatrack']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('zzzznotatrack');
    // The sibling `.trackdetails` DOES pass the raw text through to a card as
    // "Unknown Artist". Loving a track called "zzzznotatrack" would be a real,
    // irreversible write for a track that does not exist.
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });
});

describe('.love — a refused write must not render as a success', () => {
  it('reports the refusal and builds no love card', async () => {
    const { commands } = build({ lovedFails: true });

    const result = await love(commands, ['Radiohead', '|', 'Airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(desc(result)).toContain('Failed to love');
    expect(TrackBuilders.buildLoveResponse).not.toHaveBeenCalled();
  });

  it('builds the success card when Last.fm accepted the write', async () => {
    const { commands } = build();

    const result = await love(commands, ['Radiohead', '|', 'Airbag']);

    expect(result).toEqual({ marker: 'love' });
    expect(vi.mocked(TrackBuilders.buildLoveResponse).mock.calls[0]![0]).toBe('Airbag');
  });

  it('sends the caller’s session key, never a shared one', async () => {
    const { commands, lastfmRepository } = build({ caller: user({ sessionKey: 'PRIVATE-KEY' }) });

    await love(commands, ['Radiohead', '|', 'Airbag']);

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'PRIVATE-KEY');
  });
});

describe('.unlove — the mirror of love, and the same two failures', () => {
  it('tells an unauthenticated user to log in and writes nothing', async () => {
    const { commands, lastfmRepository } = build({ caller: user({ sessionKey: undefined }) });

    const result = await unlove(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
    expect(lastfmRepository.unloveTrack).not.toHaveBeenCalled();
  });

  it('reports a refused unlove and builds no card', async () => {
    const { commands } = build({ lovedFails: true });

    const result = await unlove(commands, ['Radiohead', '|', 'Airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(desc(result)).toContain('Failed to unlove');
    expect(TrackBuilders.buildUnloveResponse).not.toHaveBeenCalled();
  });

  it('builds the success card on a confirmed unlove', async () => {
    const { commands, lastfmRepository } = build();

    const result = await unlove(commands, ['Radiohead', '|', 'Airbag']);

    expect(lastfmRepository.unloveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'SK');
    expect(result).toEqual({ marker: 'unlove' });
  });

  it('reports an empty recent history rather than unlov-ing a guess', async () => {
    const { commands, lastfmRepository } = build({ recents: [] });

    const result = await unlove(commands, []);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.unloveTrack).not.toHaveBeenCalled();
  });
});

describe('.loved — an empty library is a real answer, a missing account is not', () => {
  it('reports an empty loved list with its own response code', async () => {
    // NoScrobbles, not NotFound: the user exists and has loved nothing, which
    // is a different statement from "we could not find that".
    const { commands } = build({ lovedResult: { tracks: [], total: 0 } });

    const result = await loved(commands, []);

    expect(result.commandResponse).toBe(CommandResponse.NoScrobbles);
    expect(desc(result)).toContain('does not have any loved tracks');
    expect(TrackBuilders.buildLovedTracksResponse).not.toHaveBeenCalled();
  });

  it('reports the same for a repository that answered with nothing at all', async () => {
    const { commands } = build({ lovedResult: { tracks: null, total: 0 } });

    const result = await loved(commands, []);

    expect(result.commandResponse).toBe(CommandResponse.NoScrobbles);
  });

  it('renders the list with the total the repository reported', async () => {
    const { commands } = build({
      lovedResult: { tracks: [{ artistName: 'Radiohead', name: 'Airbag' }], total: 431 },
    });

    const result = await loved(commands, []);

    const [, , , , total] = vi.mocked(TrackBuilders.buildLovedTracksResponse).mock.calls[0]!;
    expect(total).toBe(431);
    expect(result).toEqual({ marker: 'loved' });
  });

  it('refuses a mention whose target has not registered, without falling back', async () => {
    const { commands, lastfmRepository } = build({ mentioned: null });

    const result = await loved(commands, ['<@333>']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getLovedTracks).not.toHaveBeenCalled();
  });

  it('lists the mentioned user’s loved tracks, not the caller’s', async () => {
    const { commands, lastfmRepository } = build({
      mentioned: user({ userId: 7, userNameLastFm: 'Beta' }),
      lovedResult: { tracks: [{ artistName: 'A', name: 'B' }], total: 2 },
    });

    await loved(commands, ['<@999>']);

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalledWith('Beta', 200, 1, 'SK');
  });

  it('omits the session key for an account that has none, rather than sending undefined', async () => {
    // Passing the key is what makes Last.fm count a PRIVATE library, so an
    // account without one must not be sent a fabricated value.
    const { commands, lastfmRepository } = build({ caller: user({ sessionKey: undefined }) });

    await loved(commands, []);

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalledWith('Alpha', 200, 1, undefined);
  });
});

describe('.scrobble — a bare word must never scrobble anything', () => {
  it('answers with usage and writes nothing', async () => {
    const { commands, lastfmRepository } = build();

    const result = await scrobble(commands, []);

    // This is the branch that matters most in the whole file: the most recent
    // track is RIGHT THERE, and scrobbling it because the user typed `.scrobble`
    // would put a public timestamp on their history they never asked for.
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(desc(result)).toContain('Artist | Track');
  });

  it('refuses an unauthenticated caller before the usage text', async () => {
    const { commands, lastfmRepository } = build({ caller: user({ sessionKey: undefined }) });

    const result = await scrobble(commands, ['Airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });
});

describe('.scrobble — the write itself', () => {
  it('carries the album through a three-part pipe', async () => {
    const { commands, lastfmRepository } = build();

    await scrobble(commands, ['Radiohead', '|', 'Airbag', '|', 'OK Computer']);

    const [artist, name, , , album] = (lastfmRepository.scrobbleTrack as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
    expect(album).toBe('OK Computer');
  });

  it('omits the album for a two-part pipe rather than sending an empty string', async () => {
    const { commands, lastfmRepository } = build();

    await scrobble(commands, ['Radiohead', '|', 'Airbag']);

    const [artist, name, , , album] = (lastfmRepository.scrobbleTrack as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
    expect(album).toBeUndefined();
  });

  it('splits "Track by Artist"', async () => {
    const { commands, lastfmRepository } = build();

    await scrobble(commands, ['Airbag', 'by', 'Radiohead']);

    const [artist, name] = (lastfmRepository.scrobbleTrack as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
  });

  it('sends a unix timestamp in SECONDS, not milliseconds', async () => {
    const { commands, lastfmRepository } = build();

    await scrobble(commands, ['Radiohead', '|', 'Airbag']);

    const ts = (lastfmRepository.scrobbleTrack as ReturnType<typeof vi.fn>).mock.calls[0]![2] as number;
    // Last.fm rejects a millisecond timestamp as out of range, and a future one
    // is rejected as invalid, so the backdated default is deliberate.
    expect(ts).toBeLessThan(1e11);
    expect(ts).toBeGreaterThan(1e9);
  });

  it('reports a refused scrobble and builds no success card', async () => {
    const { commands } = build({ lovedFails: true });

    const result = await scrobble(commands, ['Radiohead', '|', 'Airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(desc(result)).toContain('Failed to scrobble');
    expect(TrackBuilders.buildScrobbleResponse).not.toHaveBeenCalled();
  });

  it('CHARACTERISATION: a leading separator is TRIMMED away, so it is searched as free text, not rejected', async () => {
    const { commands, lastfmRepository } = build();

    // `" | Airbag"` is a half-filled pipe with the pipe first, which is what a
    // user who typed the separator before the artist actually meant. The
    // load-bearing half holds: nothing is written, because the search finds
    // nothing and the command says so.
    //
    // The `WrongInput` branch is NOT what answers, and the reason is the
    // `.trim()` on the joined args: the leading space is gone, so `raw` is
    // `"| Airbag"`, which does not contain `" | "` and falls through to the
    // free-text search. The user is told "could not find a track matching
    // `| Airbag`" rather than "specify both an artist and track name" — a less
    // useful message, but not a wrong one. Pinned as observed; reported
    // separately.
    const result = await scrobble(commands, [' | Airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('reaches the WrongInput branch for a genuinely half-filled pipe, and writes nothing', async () => {
    // The reachable form: the separator is surrounded on BOTH sides, so `.trim()`
    // cannot remove it and the middle field survives as an empty string.
    const { commands, lastfmRepository } = build();

    const result = await scrobble(commands, ['Radiohead |  | OK Computer']);

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result)).toContain('both an artist and track name');
    // An empty artist field is a write to Last.fm with a blank credit, so this
    // is the direction that matters most.
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('reports a search that matched nothing instead of scrobbling the raw text', async () => {
    const { commands, lastfmRepository } = build({ searchHits: [] });

    const result = await scrobble(commands, ['zzzznotatrack']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('names the LAST.FM ACCOUNT on the success card, not the track', async () => {
    const { commands } = build({ caller: user({ userNameLastFm: 'Alpha' }) });

    await scrobble(commands, ['Radiohead', '|', 'Airbag']);

    const [, , account] = vi.mocked(TrackBuilders.buildScrobbleResponse).mock.calls[0]!;
    expect(account).toBe('Alpha');
  });
});

describe('the write triggers reach those bodies through the registry', () => {
  it('treats `.love list` as the loved list, not as a search for "list"', async () => {
    const { commands, lastfmRepository } = build({ lovedResult: { tracks: [{ artistName: 'A', name: 'B' }], total: 1 } });
    const love = commands.commands.find((c) => c.name === 'love')!;

    const result = await love.executeAsync(ctx(), ['list']);

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalled();
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
    expect(TrackBuilders.buildLovedTracksResponse).toHaveBeenCalled();
    expect(result).toEqual({ marker: 'loved' });
  });

  it('is case-insensitive about that mode word, so `.love LIST` is not a search', async () => {
    const { commands, lastfmRepository } = build({ lovedResult: { tracks: [{ artistName: 'A', name: 'B' }], total: 1 } });
    const love = commands.commands.find((c) => c.name === 'love')!;

    await love.executeAsync(ctx(), ['LIST']);

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalled();
  });

  it('joins a `.love track by artist` typed as separate arguments', async () => {
    const { commands, lastfmRepository } = build();
    const love = commands.commands.find((c) => c.name === 'love')!;

    await love.executeAsync(ctx(), ['Airbag', 'by', 'Radiohead']);

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'SK');
  });

  it('routes `.unlove` and `.loved` to their own bodies', async () => {
    const { commands, lastfmRepository } = build();
    const unlove = commands.commands.find((c) => c.name === 'unlove')!;
    const lovedCmd = commands.commands.find((c) => c.name === 'loved')!;

    await unlove.executeAsync(ctx(), ['Radiohead', '|', 'Airbag']);
    await lovedCmd.executeAsync(ctx(), []);

    expect(lastfmRepository.unloveTrack).toHaveBeenCalled();
    expect(lastfmRepository.getLovedTracks).toHaveBeenCalled();
  });

  it('does not collide on the name `remove`, which belongs to the queue commands', async () => {
    const { commands } = build();
    const triggers = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(triggers).not.toContain('remove');
  });
});
