import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import type { LyricsResult } from '@bot/services/music/lyricsService';

/**
 * `.lyric` / `.genius` — the one command in this family that renders raw
 * provider text straight into a Discord embed.
 *
 * Three things can go wrong, and only the middle one is obvious:
 *
 *  1. **`Artist - Track` is ambiguous.** Splitting on the first separator and
 *     throwing the rest away turns "Sigma - Rickroll - Sigma" into artist
 *     "Sigma" and track "Rickroll". The rest is rejoined, and the test pins it
 *     with a title that actually contains the separator.
 *  1b. **The separator at either END of the query.** It is tested on the raw
 *     query rather than a trimmed copy, because trimming is what made `" - X"`
 *     and `"X - "` invisible to the split. A leading one means "no artist"; a
 *     trailing one leaves an empty title and is a usage error, not a song
 *     called "X -".
 *  2. **A provider that answers with whitespace.** `plainLyrics: '   '` is
 *     "this song has no lyrics" and must render as the honest not-found. An
 *     embed built from it would show a titled card with a blank body, which
 *     reads as a bug in the bot rather than a song without words.
 *  3. **The 4096-character embed limit.** `EmbedBuilder` runs with validation
 *     on, so an over-long description THROWS and takes the command with it.
 *     The truncation is load-bearing, and the test asserts the length actually
 *     lands under the limit rather than merely that some truncation happened.
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
    message: { channelId: 'C1', author: { id: '111', username: 'caller' }, member: { displayName: 'Caller' } },
    ...over,
  }) as unknown as ContextModel;

const lyrics = (over: Partial<LyricsResult> = {}): LyricsResult => ({
  title: 'Airbag',
  artist: 'Radiohead',
  plainLyrics: 'Anyone here anyway?',
  instrumental: false,
  source: 'genius',
  ...over,
});

type Over = {
  caller?: User | null;
  recents?: RecentTrack[] | null;
  result?: LyricsResult | null;
  withLyricsService?: boolean;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...a: unknown[]) => {
      const id = a[0] as string;
      return id === '111' ? (over.caller === undefined ? user() : over.caller) : null;
    }),
  };
  const trackService = { searchTrack: vi.fn(async () => null) };
  const trackDetailsService = { getDetails: vi.fn(async () => null) };
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) =>
      (over.recents === undefined
        ? [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: true }]
        : over.recents) as RecentTrack[],
    ),
  };
  const updateService = { updateUser: vi.fn(async () => undefined) };
  const lyricsService = { getLyrics: vi.fn(async () => (over.result === undefined ? lyrics() : over.result)) };

  const commands = new TrackCommands(
    userService as never,
    trackService as never,
    trackDetailsService as never,
    lastfmRepository as never,
    updateService as never,
    over.withLyricsService === false ? undefined : (lyricsService as never),
    undefined,
  );
  return { commands, userService, lastfmRepository, lyricsService };
};

const priv = (c: TrackCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse; embed: { data: Record<string, unknown> } }>>;

const run = (c: TrackCommands, raw: string, context: ContextModel = ctx()) => priv(c)['lyricsAsync']!.bind(c)(context, raw);

const desc = (r: unknown): string => (r as { embed: { data: { description?: string } } }).embed.data.description ?? '';
const title = (r: unknown): string => (r as { embed: { data: { title?: string } } }).embed.data.title ?? '';
const footer = (r: unknown): string => (r as { embed: { data: { footer?: { text?: string } } } }).embed.data.footer?.text ?? '';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('.lyric — splitting "Artist - Track" without losing the rest of the title', () => {
  it('passes the artist and title separately to the provider', async () => {
    const { commands, lyricsService } = build();

    await run(commands, 'Radiohead - Airbag');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', 'Radiohead');
  });

  it('keeps a separator that is part of the song title', async () => {
    // "Sigma - Rickroll - Sigma" is one title. Dropping the tail would search
    // for a song that does not exist and answer "could not find lyrics".
    const { commands, lyricsService } = build();

    await run(commands, 'Someone - Sigma - Rickroll - Sigma');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Sigma - Rickroll - Sigma', 'Someone');
  });

  it('searches with no artist when the user gave only a title', async () => {
    const { commands, lyricsService } = build();

    await run(commands, 'Airbag');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', undefined);
  });

  it('a leading separator is seen by the split, so the title is searched and the artist is simply absent', async () => {
    // `" - Airbag"` is a user who typed the separator before the artist. The
    // `.trim()` on the raw query removed the leading space, so `trimmed` was
    // `"- Airbag"`, which does not contain `" - "` — the split branch was never
    // taken and the dash became part of the track name.
    //
    // The fix is to test the separator on the joined query, where the space that
    // makes it matchable still exists. An empty artist half then means "no
    // artist given", which is the same thing the bare-title path above passes,
    // so the provider is asked for `"Airbag"` with `undefined` — a title that can
    // actually resolve — rather than for a song called "- Airbag".
    const { commands, lyricsService } = build({ result: null });

    const result = await run(commands, ' - Airbag');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', undefined);
    // Still the honest not-found when nothing has lyrics for it, and still with
    // no `Artist – ` prefix, because there is no artist.
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('Airbag');
    expect(desc(result)).not.toContain('–');
  });

  it('a trailing separator is a usage error rather than a title ending in a dash', async () => {
    // The same trimming, the other side. `"Radiohead - "` leaves an empty title,
    // which used to be searched for as a song literally called "Radiohead -".
    const { commands, lyricsService } = build();

    const result = await run(commands, 'Radiohead - ');

    expect(lyricsService.getLyrics).not.toHaveBeenCalled();
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('really does keep a title that legitimately contains a dash', async () => {
    // The control for the two tests above: the same branch, entered from the
    // RIGHT side, does split and does keep the tail.
    const { commands, lyricsService } = build({ result: null });

    await run(commands, 'Radiohead - Airbag - Live');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag - Live', 'Radiohead');
  });

  it('trims the query, so a pasted title with stray spaces still matches', async () => {
    const { commands, lyricsService } = build();

    await run(commands, '   Radiohead - Airbag   ');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', 'Radiohead');
  });
});

describe('.lyric — the empty argument substitutes the caller’s now-playing track', () => {
  it('uses the most recent track when nothing is named', async () => {
    const { commands, lastfmRepository, lyricsService } = build();

    await run(commands, '');

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 1, 1, undefined, 'SK');
    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', 'Radiohead');
  });

  it('treats a whitespace-only query as the same as an empty one', async () => {
    const { commands, lyricsService } = build();

    await run(commands, '    ');

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', 'Radiohead');
  });

  it('tells an unregistered caller how to connect, and names the usage too', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await run(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('.login');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('reports an empty recent history by Last.fm name instead of guessing a song', async () => {
    const { commands, lyricsService } = build({ recents: [] });

    const result = await run(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('Alpha');
    expect(lyricsService.getLyrics).not.toHaveBeenCalled();
  });

  it('reports a null recent history the same way', async () => {
    const { commands } = build({ recents: null });

    const result = await run(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('.lyric — "no lyrics" must not render as a blank card', () => {
  it('reports a provider that returned nothing', async () => {
    const { commands } = build({ result: null });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('Could not find lyrics');
  });

  it('reports a whitespace-only body, which is what "instrumental" looks like upstream', async () => {
    // A titled embed whose body is '   ' reads as a broken bot, not as a song
    // that has no words.
    const { commands } = build({ result: lyrics({ plainLyrics: '   ' }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports an empty body the same way', async () => {
    const { commands } = build({ result: lyrics({ plainLyrics: '' }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('names the artist AND the track when the query had one', async () => {
    const { commands } = build({ result: null });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(desc(result)).toContain('Radiohead – Airbag');
  });

  it('renders an instrumental notice rather than treating it as a failure', async () => {
    // The service maps instrumental tracks to a placeholder body with a real
    // `plainLyrics` string, so this is a success, not a miss.
    const { commands } = build({
      result: lyrics({ instrumental: true, plainLyrics: '[This track is instrumental]' }),
    });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(desc(result)).toContain('instrumental');
  });

  it('names the missing capability when the lyrics service is not wired', async () => {
    // A2: "no lyrics found" would blame the song for a feature that was never
    // switched on.
    const { commands } = build({ withLyricsService: false });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(desc(result)).toContain('Lyrics service is currently unavailable');
  });
});

describe('.lyric — rendering the provider text', () => {
  it('titles the card from what the provider returned, not the raw query', async () => {
    // The provider is allowed to correct a misspelling; echoing the query back
    // would print a typo as the song's name.
    const { commands } = build({ result: lyrics({ artist: 'Radiohead', title: 'Airbag (Remastered)' }) });

    const result = await run(commands, 'radiohed - ai bag');

    expect(title(result)).toBe('🎵 Radiohead – Airbag (Remastered)');
  });

  it('trims the body it renders', async () => {
    const { commands } = build({ result: lyrics({ plainLyrics: '\n\n  Anyone here anyway?  \n\n' }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(desc(result)).toBe('Anyone here anyway?');
  });

  it('keeps a body of exactly the threshold untruncated', async () => {
    const { commands } = build({ result: lyrics({ plainLyrics: 'a'.repeat(4000) }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(desc(result)).toHaveLength(4000);
  });

  it('truncates a body over the threshold and says so', async () => {
    const { commands } = build({ result: lyrics({ plainLyrics: 'a'.repeat(9000) }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(desc(result)).toContain('(lyrics truncated)');
  });

  it('never exceeds Discord’s 4096-character embed limit', async () => {
    // EmbedBuilder validates and THROWS on an over-long description, so a
    // regression here is a crashed command rather than a clipped one.
    const { commands } = build({ result: lyrics({ plainLyrics: 'a'.repeat(20_000) }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect((result.embed.data.description as string).length).toBeLessThanOrEqual(4096);
  });

  it('credits the provider it actually used', async () => {
    const { commands } = build({ result: lyrics({ source: 'lrclib' }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(footer(result)).toBe('Lyrics provided by LRCLIB');
  });

  it('falls back to the default credit when the provider did not say', async () => {
    const { commands } = build({ result: lyrics({ source: undefined }) });

    const result = await run(commands, 'Radiohead - Airbag');

    expect(footer(result)).toBe('Lyrics provided by GENIUS');
  });

  it('uses the context accent colour when there is one', async () => {
    const { commands } = build();

    const result = await run(commands, 'Radiohead - Airbag', ctx({ accentColor: 0x445566 }));

    expect(result.embed.data.color).toBe(0x445566);
  });

  it('falls back to the Last.fm blue in a context with no accent colour', async () => {
    const { commands } = build();

    const result = await run(commands, 'Radiohead - Airbag', ctx({ accentColor: undefined }));

    expect(result.embed.data.color).toBe(DiscordConstants.LastFmColorBlue);
  });
});

describe('the lyrics trigger is named `lyric`, not `lyrics`', () => {
  it('does not claim `lyrics`, which another command owns', async () => {
    // The registry lets the later registration win silently when two modules
    // claim a trigger, so a duplicate here makes one of them unreachable.
    const { commands } = build();
    const triggers = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(triggers).toContain('lyric');
    expect(triggers).not.toContain('lyrics');
  });

  it('gives every trigger in this module a unique name', () => {
    const { commands } = build();
    const triggers = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('joins a typed `Artist - Track` argument vector before parsing', async () => {
    const { commands, lyricsService } = build();
    const cmd = commands.commands.find((c) => c.name === 'lyric')!;

    await cmd.executeAsync(ctx(), ['Radiohead', '-', 'Airbag']);

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', 'Radiohead');
  });
});
