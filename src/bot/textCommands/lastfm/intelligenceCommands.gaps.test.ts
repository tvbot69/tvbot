import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IntelligenceCommands } from './intelligenceCommands';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { DiscoveryItem, ListeningGapItem } from '@bot/services/musicIntelligenceService';

/**
 * `.artistgaps` / `.albumgaps` / `.trackgaps` and `.discoveries`.
 *
 * Every query here is `intelligenceService`, which runs raw SQL through
 * `orDatabaseUnavailable`, so a failed read RAISES and the command has nothing
 * sensible to render. The boundary to pin is that the raise escapes untouched:
 * `buildListeningGapsResponse` with `items: []` prints "No artist listening
 * gaps of 90+ days found in your listening history", which is a claim about a
 * listener's whole history and would be a lie produced by an outage.
 *
 * The two target-grammar behaviours in this file are both refusals, and both
 * are refusals because the alternative silently answers a question about one
 * person with another's data:
 *
 *  - `lfm:someone` names an account the bot has never indexed. The two queries
 *    below are keyed on `userId`, so running them for an unindexed name would
 *    read the CALLER's own rows and label them with a stranger's name. The
 *    fabricated target carries the `userId: 0` sentinel the playcount family
 *    uses, and the command refuses before either query runs - "no gaps found"
 *    is also a false claim when there is no history to have gaps in.
 *  - a mention that resolves to nobody is refused rather than dropped, so
 *    `.gaps <@333>` cannot quietly become the caller's own gaps. (The playcount
 *    and genre families refuse in the same shape and with the same wording.)
 *
 * Both were pinned as the buggy behaviour; both assertions below now pin the
 * refusal.
 */

const caller = (over: Partial<User> = {}): User =>
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
    discordDisplayName: 'Caller',
    guild: { id: '222', name: 'Test Guild', iconURL: () => 'https://img/guild.png' },
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const gap = (over: Partial<ListeningGapItem> = {}): ListeningGapItem => ({
  name: 'Radiohead',
  artistName: 'Radiohead',
  resumeDate: new Date(2024, 4, 1),
  prevPlayed: new Date(2023, 11, 1),
  gapDays: 152,
  totalPlays: 400,
  ...over,
});

const discovery = (over: Partial<DiscoveryItem> = {}): DiscoveryItem => ({
  artistName: 'Boards of Canada',
  firstPlay: new Date(2024, 2, 3),
  playcount: 12,
  ...over,
});

const settings = (over: Partial<TimeSettingsModel> = {}): TimeSettingsModel =>
  ({ timePeriod: TimePeriod.AllTime, description: 'Alltime', searchValue: '', ...over }) as TimeSettingsModel;

type Over = {
  caller?: User | null;
  mentioned?: User | null;
  byLfmName?: User | null;
  gaps?: ListeningGapItem[];
  gapsRaise?: unknown;
  discoveries?: DiscoveryItem[];
  discoveriesRaise?: unknown;
  timeSettings?: TimeSettingsModel;
  artUrl?: string | null;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...a: unknown[]) => {
      const id = a[0] as string;
      if (id !== '111') return (over.mentioned ?? null) as User | null;
      return over.caller === undefined ? caller() : over.caller;
    }),
    getUserByLastFmName: vi.fn(async () => (over.byLfmName ?? null) as User | null),
  };
  const settingService = { getTimePeriod: vi.fn(() => (over.timeSettings as TimeSettingsModel) ?? settings()) };
  const lastfmRepository = { getTopArtists: vi.fn(async () => []) };
  const intelligenceService = {
    getListeningGaps: vi.fn(async (..._a: unknown[]) => {
      if (over.gapsRaise) throw over.gapsRaise;
      return (over.gaps ?? [gap()]) as ListeningGapItem[];
    }),
    getDiscoveries: vi.fn(async (..._a: unknown[]) => {
      if (over.discoveriesRaise) throw over.discoveriesRaise;
      return (over.discoveries ?? [discovery()]) as DiscoveryItem[];
    }),
    getIceberg: vi.fn(async () => ({ displayName: 'x', userNameLastFm: 'x', timePeriodDescription: 'x', tiers: [], totalArtists: 0 })),
    getGuildAffinity: vi.fn(async () => ({ userDisplayName: 'x', userNameLastFm: 'x', guildName: 'x', neighbors: [], totalGuildUsers: 0 })),
  };
  const colorService = {
    getColorFromImageUrl: vi.fn(async (..._a: unknown[]) => 0x445566),
    extractAccentColor: vi.fn(async () => 0x778899),
  };
  const icebergGenerator = { generateIceberg: vi.fn(async () => Buffer.from('iceberg')) };
  const artworkService = {
    getArtistImageUrl: vi.fn(async (..._a: unknown[]) => (over.artUrl === undefined ? 'https://img/artist.png' : over.artUrl)),
    getAlbumCoverUrl: vi.fn(async (..._a: unknown[]) => (over.artUrl === undefined ? 'https://img/album.png' : over.artUrl)),
    getTrackCoverUrl: vi.fn(async (..._a: unknown[]) => (over.artUrl === undefined ? 'https://img/track.png' : over.artUrl)),
  };

  const commands = new IntelligenceCommands(
    userService as never,
    settingService as never,
    lastfmRepository as never,
    intelligenceService as never,
    colorService as never,
    icebergGenerator as never,
    artworkService as never,
  );
  return { commands, userService, settingService, lastfmRepository, intelligenceService, colorService, artworkService, icebergGenerator };
};

const priv = (c: IntelligenceCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>>;

const gaps = (c: IntelligenceCommands, raw: string, type: 'artist' | 'album' | 'track', context: ContextModel = ctx()) =>
  priv(c)['listeningGapsAsync']!.bind(c)(context, raw, type);
const discoveries = (c: IntelligenceCommands, raw: string, context: ContextModel = ctx()) =>
  priv(c)['discoveriesAsync']!.bind(c)(context, raw);

const gapParams = () => vi.mocked(IntelligenceBuilders.buildListeningGapsResponse).mock.calls[0]![0];
const discoveryParams = () => vi.mocked(IntelligenceBuilders.buildDiscoveriesResponse).mock.calls[0]![0];

/** The refusal text, read off the embed the real builder produced. */
const desc = (r: unknown): string =>
  (r as { embed: { data: { description?: string } } }).embed.data.description ?? '';

const dbDown = () =>
  new SourceUnavailableError('getListeningGaps:artist', new Error('connect ECONNREFUSED'), 'Database unavailable');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(IntelligenceBuilders, 'buildListeningGapsResponse').mockReturnValue({ marker: 'gaps' } as never);
  vi.spyOn(IntelligenceBuilders, 'buildDiscoveriesResponse').mockReturnValue({ marker: 'disco' } as never);
});

describe('.gaps — the entity type decides which SQL runs', () => {
  it('asks for artist gaps for the artist trigger', async () => {
    const { commands, intelligenceService } = build();

    await gaps(commands, '', 'artist');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'artist', 90);
    expect(gapParams().entityType).toBe('artist');
  });

  it('asks for album gaps for the album trigger', async () => {
    const { commands, intelligenceService } = build();

    await gaps(commands, '', 'album');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'album', 90);
  });

  it('asks for track gaps for the track trigger', async () => {
    const { commands, intelligenceService } = build();

    await gaps(commands, '', 'track');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'track', 90);
  });

  it('lets a type word in the query override the trigger it was typed on', async () => {
    // `.artistgaps track radiohead` is asking about TRACKS. Silently keeping
    // `artist` would answer a different question than the one typed.
    const { commands, intelligenceService } = build();

    await gaps(commands, 'track radiohead', 'artist');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'track', 90);
    expect(gapParams().entityType).toBe('track');
  });

  it('recognises the plural and the `song` synonym', async () => {
    const { commands, intelligenceService } = build();

    await gaps(commands, 'songs', 'artist');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'track', 90);
  });

  it('prefers `album` over `track` when both words are present', async () => {
    // The arms are ordered, not scored. Pinning the order is what makes the
    // `.gaps album tracks` case a known outcome rather than an accident.
    const { commands, intelligenceService } = build();

    await gaps(commands, 'album tracks', 'artist');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(1, 'album', 90);
  });

  it('asks for the 90-day minimum the card headline claims', async () => {
    const { commands, intelligenceService } = build();

    await gaps(commands, '', 'artist');

    // The builder prints "after a hiatus of at least 90 days"; a shorter window
    // would put that sentence on rows that do not meet it.
    expect((intelligenceService.getListeningGaps as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe(90);
  });
});

describe('.gaps — an unreadable query must not render as "no gaps found"', () => {
  it('renders the empty card for a listener who genuinely has none', async () => {
    const { commands } = build({ gaps: [] });

    const result = await gaps(commands, '', 'artist');

    expect(result).toEqual({ marker: 'gaps' });
    expect(gapParams().items).toEqual([]);
    expect(IntelligenceBuilders.buildListeningGapsResponse).toHaveBeenCalledTimes(1);
  });

  it('makes no artwork lookup when there is nothing to colour from', async () => {
    const { commands, artworkService } = build({ gaps: [] });

    await gaps(commands, '', 'artist');

    // A decorative read on an empty list would be a wasted request, and a
    // failing one would break a command whose data is already complete.
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
    expect(gapParams().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('lets a failed query raise so no empty card can escape', async () => {
    const { commands } = build({ gapsRaise: dbDown() });

    await expect(gaps(commands, '', 'artist')).rejects.toThrow(/Database unavailable/);

    expect(IntelligenceBuilders.buildListeningGapsResponse).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller before running any SQL', async () => {
    const { commands, intelligenceService } = build({ caller: null });

    const result = await gaps(commands, '', 'artist');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(intelligenceService.getListeningGaps).not.toHaveBeenCalled();
  });
});

describe('.gaps — the accent colour follows the entity type', () => {
  it('uses the artist image for artist gaps', async () => {
    const { commands, artworkService } = build();

    await gaps(commands, '', 'artist');

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(gapParams().accentColor).toBe(0x445566);
  });

  it('uses the album cover for album gaps, with the artist for disambiguation', async () => {
    const { commands, artworkService } = build({ gaps: [gap({ name: 'Kid A', artistName: 'Radiohead' })] });

    await gaps(commands, '', 'album');

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('Kid A', 'Radiohead');
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('sends an empty artist rather than undefined when the row has none', async () => {
    const { commands, artworkService } = build({ gaps: [gap({ name: 'Untitled', artistName: undefined })] });

    await gaps(commands, '', 'track');

    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('Untitled', '');
  });

  it('keeps the default colour when the catalogue has no image', async () => {
    const { commands, colorService } = build({ artUrl: null });

    await gaps(commands, '', 'artist');

    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    expect(gapParams().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });
});

describe('.gaps — who the card is about', () => {
  it('uses the caller’s own Discord id for both pager ids on a self query', async () => {
    const { commands } = build();

    await gaps(commands, '', 'artist');

    // The pager buttons are keyed on `callerId:targetId`, so a self query has to
    // render both from the same id or the buttons address nobody.
    expect(gapParams().callerDiscordId).toBe('111');
    expect(gapParams().targetDiscordId).toBe('111');
  });

  it('redirects a mention to that user and strips it from the query', async () => {
    const { commands, userService, intelligenceService } = build({
      mentioned: caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }),
    });

    await gaps(commands, '<@999> album', 'artist');

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('999');
    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(7, 'album', 90);
    expect(gapParams().targetDiscordId).toBe('999');
    expect(gapParams().displayName).toBe('Beta');
  });

  it('REFUSES an unregistered mention instead of answering with the caller', async () => {
    // The opposite of the case above. Dropping the mention made `.gaps <@333>`
    // return the CALLER's gaps under the CALLER's name, with nothing on screen
    // contradicting what happened. `playcountCommands` and the genre family
    // refuse in exactly this shape; the two are locked in both directions.
    const { commands, userService, intelligenceService } = build({ mentioned: null });

    const result = await gaps(commands, '<@333>', 'artist');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('<@333>');
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('333');
    expect(intelligenceService.getListeningGaps).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildListeningGapsResponse).not.toHaveBeenCalled();
  });

  it('REFUSES an `lfm:` account the bot has no index for, without reading the caller', async () => {
    // `getListeningGaps` is keyed on `userId`, so the fabricated target has to
    // be a `userId: 0` sentinel AND the query has to be skipped: running it
    // would answer with the caller's own listening history under a stranger's
    // name. Refusing also beats the honest-looking empty card, which claims a
    // whole history of gaps that does not exist.
    const { commands, userService, intelligenceService } = build({ byLfmName: null });

    const result = await gaps(commands, 'lfm:ghost', 'artist');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('ghost');
    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('ghost');
    expect(intelligenceService.getListeningGaps).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildListeningGapsResponse).not.toHaveBeenCalled();
  });

  it('REFUSES the discovery query for the same unindexed `lfm:` account', async () => {
    // `getDiscoveries` is keyed on `userId` too, so the second of the pair has
    // to be covered or the fix only holds for one of the two commands.
    const { commands, intelligenceService } = build({ byLfmName: null });

    const result = await discoveries(commands, 'lfm:ghost weekly');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('ghost');
    expect(intelligenceService.getDiscoveries).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildDiscoveriesResponse).not.toHaveBeenCalled();
  });

  it('uses a registered `lfm:` target’s own rows', async () => {
    const { commands, intelligenceService } = build({
      byLfmName: caller({ userId: 42, discordUserId: '888', userNameLastFm: 'Beta' }),
    });

    await gaps(commands, 'lfm:Beta', 'artist');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(42, 'artist', 90);
  });

  it('matches the `lfm:` prefix case-insensitively', async () => {
    const { commands, userService } = build({ byLfmName: caller({ userId: 42 }) });

    await gaps(commands, 'LFM:Beta', 'artist');

    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('Beta');
  });

  it('reads a dotted Last.fm name whole, and leaves the period to the period parser', async () => {
    // The prefix used to stop at the first dot, so `lfm:john.smith weekly`
    // captured `john`, looked THAT name up, and left `.smith weekly` for the
    // period parser - which knows no such period and reads the window as all
    // time. A weekly card titled with a nine-month window.
    const { commands, userService, settingService } = build({
      byLfmName: caller({ userId: 42, discordUserId: '888', userNameLastFm: 'john.smith' }),
    });

    await discoveries(commands, 'lfm:john.smith weekly');

    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('john.smith');
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
  });
});

describe('.discoveries — the window, which is the whole claim on the card', () => {
  it('bounds an all-time request to the last 90 days and says so', async () => {
    // The token says all time; the card says "the past 90 days". Both have to
    // be true, so the description cannot come from the parsed token.
    const { commands, intelligenceService } = build();

    // Bracket the call. Production stamps `now` when it runs, so reading the
    // clock afterwards can only ever measure a window that is one millisecond
    // WIDER than ninety days, and an upper bound of exactly ninety days then
    // fails on a slow machine. Both bounds are read against a clock captured
    // either side of the call instead.
    const before = Date.now();
    await discoveries(commands, 'alltime');
    const after = Date.now();

    const [, start, end] = (intelligenceService.getDiscoveries as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(before - (start as Date).getTime()).toBeLessThanOrEqual(ninetyDays);
    expect(after - (start as Date).getTime()).toBeGreaterThanOrEqual(ninetyDays);
    // The claim the card makes is "about ninety days", so hold it to a second.
    expect(after - (start as Date).getTime()).toBeLessThanOrEqual(ninetyDays + 1000);
    expect((end as Date).getTime()).toBeGreaterThan((start as Date).getTime());
    expect(discoveryParams().periodDescription).toBe('the past 90 days');
  });

  it('uses the parsed window for a bounded period', async () => {
    const { commands, intelligenceService } = build({
      timeSettings: settings({
        timePeriod: TimePeriod.Weekly,
        description: 'Weekly',
        startDateTime: new Date(2024, 0, 1),
        endDateTime: new Date(2024, 0, 8),
      }),
    });

    await discoveries(commands, 'weekly');

    const [, start, end] = (intelligenceService.getDiscoveries as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(start).toEqual(new Date(2024, 0, 1));
    expect(end).toEqual(new Date(2024, 0, 8));
    expect(discoveryParams().periodDescription).toBe('Weekly');
  });

  it('closes an open-ended window at now rather than leaving it unbounded', async () => {
    const { commands, intelligenceService } = build({
      timeSettings: settings({ timePeriod: TimePeriod.Monthly, description: 'Monthly', startDateTime: new Date(2024, 0, 1) }),
    });

    await discoveries(commands, 'monthly');

    const [, , end] = (intelligenceService.getDiscoveries as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // An absent end date becomes `new Date()`, not null. Passing null through
    // would make the query "everything since January", which is a different
    // claim from "this month".
    expect(end).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (end as Date).getTime())).toBeLessThan(60_000);
  });

  it('parses the period from the query after the target token is removed', async () => {
    const { commands, settingService } = build({
      byLfmName: caller({ userId: 42, discordUserId: '888', userNameLastFm: 'Beta' }),
      timeSettings: settings({ timePeriod: TimePeriod.Weekly, description: 'Weekly' }),
    });

    await discoveries(commands, 'lfm:Beta weekly');

    // A surviving `lfm:Beta` in the period parser is how a weekly chart
    // becomes an all-time one.
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
  });

  it('renders the empty card when nothing new was discovered', async () => {
    const { commands } = build({ discoveries: [] });

    const result = await discoveries(commands, 'weekly');

    expect(result).toEqual({ marker: 'disco' });
    expect(discoveryParams().items).toEqual([]);
  });

  it('lets a failed query raise rather than claiming nothing new was found', async () => {
    // "You discovered nothing this week" is the answer for an empty row set.
    // Printing it for a dropped connection is the failure this guards.
    const { commands } = build({ discoveriesRaise: dbDown() });

    await expect(discoveries(commands, 'weekly')).rejects.toThrow(/Database unavailable/);
    expect(IntelligenceBuilders.buildDiscoveriesResponse).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller before running any SQL', async () => {
    const { commands, intelligenceService } = build({ caller: null });

    const result = await discoveries(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(intelligenceService.getDiscoveries).not.toHaveBeenCalled();
  });

  it('colours from the first discovered artist, and only that one', async () => {
    const { commands, artworkService } = build({
      discoveries: [discovery(), discovery({ artistName: 'Aphex Twin' })],
    });

    await discoveries(commands, 'alltime');

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledTimes(1);
    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Boards of Canada');
  });

  it('keeps the default colour when the first discovery has no image', async () => {
    const { commands, colorService } = build({ artUrl: null });

    await discoveries(commands, 'alltime');

    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    expect(discoveryParams().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });
});

describe('the gaps and discovery triggers reach those bodies through the registry', () => {
  it('gives each gaps trigger its own entity type', async () => {
    const { commands, intelligenceService } = build();

    for (const name of ['artistgaps', 'albumgaps', 'trackgaps']) {
      const cmd = commands.commands.find((c) => c.name === name)!;
      expect(cmd).toBeDefined();
      await cmd.executeAsync(ctx(), []);
    }

    const types = (intelligenceService.getListeningGaps as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(types).toEqual(['artist', 'album', 'track']);
  });

  it('routes the short aliases to the same bodies', async () => {
    const { commands, intelligenceService } = build();
    const gaps = commands.commands.find((c) => c.name === 'artistgaps')!;
    expect(gaps.aliases).toEqual(['gaps', 'gap', 'agaps', 'artistgap']);

    await gaps.executeAsync(ctx(), ['radiohead']);
    await commands.commands.find((c) => (c.aliases ?? []).includes('gap'))!.executeAsync(ctx(), ['radiohead']);

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledTimes(2);
  });

  it('routes `d` to the discoveries body', async () => {
    const { commands, intelligenceService } = build();
    const disc = commands.commands.find((c) => c.name === 'discoveries')!;
    expect(disc.aliases).toContain('d');

    await disc.executeAsync(ctx(), ['weekly']);

    expect(intelligenceService.getDiscoveries).toHaveBeenCalledTimes(1);
  });
});