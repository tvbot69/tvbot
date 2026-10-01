import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaycountCommands } from '../playcountCommands';
import { ReceiptBuilders } from '@bot/builders/receiptBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * `.receipt` / `.rcpt` — the one command in this family that renders a
 * GENERATED IMAGE with numbers baked into it.
 *
 * The period grammar is hand-written, and the decision it makes is invisible
 * from the outside: a set of bare tokens is checked for FIRST, and only if one
 * is present is the settings parser consulted. So `.receipt` with no argument is
 * a receipt for THIS CALENDAR MONTH, not for all time and not for the user's
 * lifetime. Both branches are pinned because getting them backwards produces a
 * perfectly plausible image of the wrong month.
 *
 * The `tracksUrl` matters for the same reason: it is what the image title links
 * to, so a window URL with a fabricated end date sends the user to a Last.fm
 * page that does not show what the receipt claims. It is also the reason the
 * play COUNT is bounded: the number baked into the image and the window its own
 * link describes are one claim, and they used to disagree — the count ran from
 * the period start to NOW, so a 2023 receipt printed "plays since 2023" beside a
 * link to 2023.
 *
 * Finally the total: a null scrobble count falls back to the sum of the tracks'
 * own playcounts. The tempting alternative is `?? 0`, which would print "0
 * plays" across the top of an image of a real month of listening.
 *
 * All date fixtures are built with the LOCAL-time constructor. `getFullYear` /
 * `getMonth` / `getDate` are what the URL builder reads, so a UTC midnight would
 * render as the previous day for anyone west of Greenwich.
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
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const topTracks = [
  { name: 'Airbag', artistName: 'Radiohead', playcount: 30 },
  { name: 'Karma Police', artistName: 'Radiohead', playcount: 12 },
];

const settings = (over: Partial<TimeSettingsModel> = {}): TimeSettingsModel =>
  ({ timePeriod: TimePeriod.AllTime, description: 'Alltime', searchValue: '', ...over }) as TimeSettingsModel;

type ReceiptDouble = { generateReceipt: (...a: unknown[]) => Promise<Buffer> };

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...a: unknown[]) => {
      const id = a[0] as string;
      if (id !== '111') return (over.mentioned ?? null) as User | null;
      return over.caller === undefined ? caller() : (over.caller as User | null);
    }),
    getUserByLastFmName: vi.fn(async () => (over.byLfmName ?? null) as User | null),
  };
  const settingService = { getTimePeriod: vi.fn(() => (over.timeSettings as TimeSettingsModel) ?? settings()) };
  const playHistoryService = {
    getScrobbleCountFromDate: vi.fn(async (..._a: unknown[]) =>
      over.scrobbleCount === undefined ? 77 : (over.scrobbleCount as number | null),
    ),
  };
  const lastfmRepository = {
    getTopTracks: vi.fn(async (..._a: unknown[]) =>
      ('topTracks' in over ? over.topTracks : topTracks) as unknown[] | null,
    ),
  };
  const artworkService = { getTrackCoverUrl: vi.fn(async () => 'https://img/cover.png') };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x445566) };
  const receiptGenerator: ReceiptDouble | undefined =
    'withGenerator' in over
      ? (over.withGenerator as ReceiptDouble | undefined)
      : { generateReceipt: vi.fn(async (..._a: unknown[]) => Buffer.from('png')) };

  const commands = new PlaycountCommands(
    userService as never,
    settingService as never,
    playHistoryService as never,
    {} as never,
    {} as never,
    {} as never,
    artworkService as never,
    lastfmRepository as never,
    colorService as never,
    receiptGenerator as never,
  );
  return { commands, userService, settingService, playHistoryService, lastfmRepository, artworkService, colorService, receiptGenerator };
};

const priv = (c: PlaycountCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>>;

const receipt = (c: PlaycountCommands, raw: string) => priv(c)['receiptAsync']!.bind(c)(ctx(), raw);

/**
 * The REAL params object, read off the builder instead of re-declared. The
 * hand-written copy of this shape had already drifted: it dropped the required
 * `userNameLastFm`, which is the name the card title links to, so the tests read
 * a params object that could never be the one production passes. Deriving it
 * means the next added field is a compile error here rather than a silent gap.
 */
type ReceiptParams = Parameters<typeof ReceiptBuilders.buildReceiptResponse>[0];

/** What the image was actually told to draw. */
const receiptParams = (): ReceiptParams => vi.mocked(ReceiptBuilders.buildReceiptResponse).mock.calls[0]![0];

/** What the generator was actually told to draw, which is the number on the image. */
const generatorPayload = (c: PlaycountCommands): Record<string, unknown> => {
  const gen = (c as unknown as { receiptGenerator: { generateReceipt: { mock: { calls: unknown[][] } } } }).receiptGenerator;
  return gen.generateReceipt.mock.calls[0]![0] as Record<string, unknown>;
};

const desc = (r: unknown): string => (r as { embed: { data: { description?: string } } }).embed.data.description ?? '';

/**
 * The zero-padding the window url is built with, written out here on purpose: a
 * test that imported the production helper would follow it silently, and the
 * whole point of these expectations is to be an independent reading of the shape.
 */
const pad2 = (value: number): string => String(value).padStart(2, '0');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ReceiptBuilders, 'buildReceiptResponse').mockReturnValue({ marker: 'receipt' } as never);
});

describe('.receipt — no period token means THIS CALENDAR MONTH', () => {
  it('defaults to the current month rather than all time', async () => {
    const { commands, lastfmRepository } = build();

    await receipt(commands, '');

    expect(lastfmRepository.getTopTracks).toHaveBeenCalledWith('Alpha', TimePeriod.Monthly, 12);
    expect(receiptParams().periodDescription).toBe(new Date().toLocaleString('en-US', { month: 'long' }));
  });

  it('never consults the period parser when no token is present', async () => {
    const { commands, settingService } = build();

    await receipt(commands, '');

    expect(settingService.getTimePeriod).not.toHaveBeenCalled();
  });

  it('counts from the first of that month', async () => {
    const { commands, playHistoryService } = build();

    await receipt(commands, '');

    const from = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as number;
    const now = new Date();
    expect(from).toBe(Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000));
  });

  it('bounds that count to the same window the link names, and never past it', async () => {
    // The receipt's `totalPlays` is baked into the image, and it used to be
    // counted from the period start with no end, so a `.receipt 2023` printed
    // "plays since 2023" while the image's own link showed 2023 alone. The count
    // and the link are one claim about one window, so they are bounded by the
    // same day.
    const { commands, playHistoryService } = build();

    await receipt(commands, '');

    const call = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const from = call[1] as number;
    const to = call[3] as number;
    const now = new Date();
    const urlEndDayEnd = Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime() / 1000);
    // A real window, not an open-ended run to now.
    expect(to).toBeGreaterThan(from);
    // Never wider than the day the image's own link names.
    expect(to).toBeLessThanOrEqual(urlEndDayEnd);
    // And never in the future: a `to` past now asks for scrobbles that cannot
    // exist yet, which is the one vendor behaviour here that cannot be probed
    // from this machine, so the request is kept inside what is answerable.
    expect(to).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    expect(receiptParams().tracksUrl).toContain(
      `to=${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(lastDay)}`,
    );
  });

  it('builds a from/to window for the current month', async () => {
    // Zero-padded on both ends: `2026-03-01`, not `2026-3-1`. The original
    // unpadded interpolation is UNMEASURED against the live API — whether
    // Last.fm's library parser accepts `2026-3-1` was never probed and could not
    // be from here — so this asserts the format, not that the server accepts it.
    // Padded is right either way, and it is what every other date field the bot
    // prints looks like.
    const { commands } = build();

    await receipt(commands, '');

    const now = new Date();
    const month = now.getMonth() + 1;
    const lastDay = new Date(now.getFullYear(), month, 0).getDate();
    expect(receiptParams().tracksUrl).toMatch(
      new RegExp(`^https://last\\.fm/user/Alpha/library/tracks\\?from=\\d{4}-${pad2(month)}-01&to=\\d{4}-${pad2(month)}-${pad2(lastDay)}$`),
    );
  });

  it('ignores a stray artist word rather than filtering the receipt by it', async () => {
    // A receipt has no search box. `.receipt radiohead` is a month receipt for
    // the caller, not a receipt restricted to one artist.
    const { commands, lastfmRepository } = build();

    await receipt(commands, 'radiohead');

    expect(lastfmRepository.getTopTracks).toHaveBeenCalledWith('Alpha', TimePeriod.Monthly, 12);
  });
});

describe('.receipt — an explicit period routes through the settings parser', () => {
  const weekly = settings({
    timePeriod: TimePeriod.Weekly,
    description: 'Weekly',
    startDateTime: new Date(2024, 2, 1),
    endDateTime: new Date(2024, 2, 8),
  });

  it('uses the period the parser resolved', async () => {
    const { commands, settingService, lastfmRepository } = build({ timeSettings: weekly });

    await receipt(commands, 'weekly');

    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
    expect(lastfmRepository.getTopTracks).toHaveBeenCalledWith('Alpha', TimePeriod.Weekly, 12);
    expect(receiptParams().periodDescription).toBe('Weekly');
  });

  it('links to the window the parser produced, zero-padded', async () => {
    const { commands } = build({ timeSettings: weekly });

    await receipt(commands, 'weekly');

    expect(receiptParams().tracksUrl).toBe('https://last.fm/user/Alpha/library/tracks?from=2024-03-01&to=2024-03-08');
  });

  it('counts from the parsed start, in seconds', async () => {
    const { commands, playHistoryService } = build({ timeSettings: weekly });

    await receipt(commands, 'weekly');

    const from = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as number;
    expect(from).toBe(Math.floor(new Date(2024, 2, 1).getTime() / 1000));
  });

  it('counts to the end of the day the link names, not to now and not to its midnight', async () => {
    // The paired half of the default-month test, on the explicit-period branch.
    // `endDateTime` is a DATE here, and the url prints it as a date — so the
    // count has to cover that whole day. Stopping at midnight would silently drop
    // every play after it while the link still showed the day.
    const { commands, playHistoryService } = build({ timeSettings: weekly });

    await receipt(commands, 'weekly');

    const to = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]![3] as number;
    expect(to).toBe(Math.floor(new Date(2024, 2, 8, 23, 59, 59).getTime() / 1000));
  });

  it('falls back to the plain library page for an open-ended period', async () => {
    // An open-ended period has no end, so a `to=` would be a fabricated
    // boundary and the link would show more than the receipt.
    const { commands } = build({ timeSettings: settings({ timePeriod: TimePeriod.AllTime, description: 'Alltime' }) });

    await receipt(commands, 'alltime');

    expect(receiptParams().tracksUrl).toBe('https://last.fm/user/Alpha/library/tracks');
  });

  it('leaves the count unbounded when the link is, rather than inventing an end', async () => {
    // The other direction of the same fix. An all-time receipt links to an
    // unbounded page, so bounding the COUNT would be the same disagreement in
    // reverse: a number for a shorter window than the image's own link.
    const { commands, playHistoryService } = build({ timeSettings: settings({ timePeriod: TimePeriod.AllTime, description: 'Alltime' }) });

    await receipt(commands, 'alltime');

    const [name, from, sessionKey, to] = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('Alpha');
    expect(from).toBeNull();
    expect(sessionKey).toBe('SK');
    expect(to).toBeNull();
  });

  it('recognises the short period tokens, not only the long word', async () => {
    // Only the long word is memorable, but a user who types `2y` and silently
    // gets this calendar month is looking at a real image of the wrong period.
    for (const token of ['w', '7d', 'q', '3m', 'hy', '6m', '1m', '30d', '2y', 'y', '365d', 'at']) {
      const { commands, lastfmRepository } = build({ timeSettings: weekly });

      await receipt(commands, token);

      expect(lastfmRepository.getTopTracks).toHaveBeenCalledWith('Alpha', TimePeriod.Weekly, 12);
    }
  });

  it('matches the period token case-insensitively', async () => {
    const { commands, lastfmRepository } = build({ timeSettings: weekly });

    await receipt(commands, 'WeEkLy');

    expect(lastfmRepository.getTopTracks).toHaveBeenCalledWith('Alpha', TimePeriod.Weekly, 12);
  });

  it('escapes the Last.fm name in the link rather than splicing it raw', async () => {
    const { commands } = build({ caller: caller({ userNameLastFm: 'a b' }) });

    await receipt(commands, 'alltime');

    expect(receiptParams().tracksUrl).toBe('https://last.fm/user/a%20b/library/tracks');
  });

  it('labels the image with the TARGET, not the caller who typed it', async () => {
    const { commands } = build();

    await receipt(commands, 'lfm:ghost alltime');

    expect(generatorPayload(commands)).toMatchObject({ userNameLastFm: 'ghost', displayName: 'ghost' });
  });
});

describe('.receipt — an unreadable source must not become an image of nothing', () => {
  it('reports the empty top-tracks list instead of generating a blank receipt', async () => {
    const { commands, receiptGenerator } = build({ topTracks: [] });

    const result = await receipt(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(receiptGenerator?.generateReceipt).not.toHaveBeenCalled();
    expect(ReceiptBuilders.buildReceiptResponse).not.toHaveBeenCalled();
  });

  it('reports a top-tracks read that returned nothing at all', async () => {
    // `null` and `[]` are two vendor shapes for the same empty answer, and both
    // have to reach the user as the honest "no top tracks" message.
    const { commands } = build({ topTracks: null });

    const result = await receipt(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('time period');
  });

  it('names the missing capability rather than blaming the user’s listening', async () => {
    // A2: without the generator this is a half-built feature, and "you don't
    // have any top tracks" would send the user off to check a month that is
    // perfectly fine.
    const { commands } = build({ withGenerator: undefined });

    const result = await receipt(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(desc(result)).toContain('Receipt generator is not available');
  });

  it('falls back to the sum of the tracks when the play count is unreadable', async () => {
    const { commands } = build({ scrobbleCount: null });

    await receipt(commands, '');

    // 30 + 12. A `?? 0` here would print "0 plays" over a real month.
    expect(generatorPayload(commands)).toMatchObject({ totalPlays: 42, totalTracks: 2 });
  });

  it('uses the real play count when there is one', async () => {
    const { commands } = build({ scrobbleCount: 500 });

    await receipt(commands, '');

    expect(generatorPayload(commands)).toMatchObject({ totalPlays: 500 });
  });

  it('draws the year it ran in, not the year of the period', async () => {
    // The generator stamps the year for the collage footer; an all-time receipt
    // is the current year whatever window it covers.
    const { commands } = build();

    await receipt(commands, 'alltime');

    expect(generatorPayload(commands)).toMatchObject({ year: new Date().getFullYear() });
  });

  it('refuses before touching Last.fm when the caller has not connected an account', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await receipt(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getTopTracks).not.toHaveBeenCalled();
  });

  it('refuses a mention whose target has not registered', async () => {
    const { commands, lastfmRepository } = build();

    const result = await receipt(commands, '<@333> alltime');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getTopTracks).not.toHaveBeenCalled();
  });
});
