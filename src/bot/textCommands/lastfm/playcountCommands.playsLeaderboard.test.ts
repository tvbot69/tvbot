import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaycountCommands } from './playcountCommands';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { GuildLeaderboardEntry } from '@bot/services/playHistoryService';

/**
 * `.plays` / `.scrobbles` and the two guild leaderboards.
 *
 * Two trust boundaries here, and they pull in opposite directions.
 *
 * `.plays` has to tell a FAILED read apart from a GENUINE zero. `count === null`
 * is the failure signal and it renders "could not find total count", while 0 is
 * a legitimate answer for a brand new account — so a fix that treated a null
 * and a 0 the same way (or the reverse) would either hide an outage or make a
 * real account look broken. Both directions are asserted, and so is the unit
 * conversion, because the period boundaries are `Date`s from the settings parser
 * and Last.fm wants epoch SECONDS: passing milliseconds back would silently ask
 * Last.fm for a window starting in 1970 and return everything.
 *
 * The leaderboards are the opposite shape. `[]` is NOT an outage — the builder
 * turns it into "No members found with plays in this server yet", a claim about
 * every member of a real server. `playHistoryService` raises on a failed query
 * for exactly that reason, so the boundary here is that the command must let
 * the raise through instead of substituting anything, while a genuinely empty
 * guild still renders the empty card.
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

const guildCtx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { id: '222', name: 'Test Guild', iconURL: () => 'https://img/guild.png' },
    prefix: '.',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const dmCtx = () => guildCtx({ guildId: undefined, guild: null });

const settings = (over: Partial<TimeSettingsModel> = {}): TimeSettingsModel =>
  ({
    timePeriod: TimePeriod.AllTime,
    description: 'Alltime',
    searchValue: '',
    ...over,
  }) as TimeSettingsModel;

const dbDown = () =>
  new SourceUnavailableError('playRepository.getGuildPlayTotals', new Error('db down'), 'Database unavailable');

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? caller() : (over.caller as User | null))),
    getUserByLastFmName: vi.fn(async () => null),
  };
  const settingService = { getTimePeriod: vi.fn(() => (over.timeSettings as TimeSettingsModel) ?? settings()) };
  const playHistoryService = {
    getScrobbleCountFromDate: vi.fn(async (..._args: unknown[]) =>
      over.scrobbleCount === undefined ? 42 : (over.scrobbleCount as number | null),
    ),
    getGuildPlayLeaderboard: vi.fn(async (..._args: unknown[]) =>
      (over.playEntries as GuildLeaderboardEntry[]) ?? [],
    ),
    getGuildTimeLeaderboard: vi.fn(async (..._args: unknown[]) =>
      (over.timeEntries as GuildLeaderboardEntry[]) ?? [],
    ),
  };
  const lastfmRepository = {
    getUserInfo: vi.fn(async () =>
      over.userInfo === undefined
        ? { name: 'Alpha', playCount: 1234, registeredAt: new Date('2010-01-01') }
        : (over.userInfo as { playCount: number } | null),
    ),
  };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x445566) };
  const commands = new PlaycountCommands(
    userService as never,
    settingService as never,
    playHistoryService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    lastfmRepository as never,
    colorService as never,
    undefined,
  );
  return { commands, userService, settingService, playHistoryService, lastfmRepository, colorService };
};

const priv = (c: PlaycountCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>>;

const plays = (c: PlaycountCommands, raw: string) => priv(c)['playsAsync']!.bind(c)(guildCtx(), raw);
const playLeaderboard = (c: PlaycountCommands, context: ContextModel) =>
  priv(c)['playLeaderboardAsync']!.bind(c)(context);
const timeLeaderboard = (c: PlaycountCommands, context: ContextModel) =>
  priv(c)['timeLeaderboardAsync']!.bind(c)(context);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(PlaycountBuilders, 'buildPlaysResponse').mockReturnValue({ marker: 'plays' } as never);
  vi.spyOn(PlaycountBuilders, 'buildLeaderboardResponse').mockReturnValue({ marker: 'lb' } as never);
});

describe('.plays — all time reads Last.fm, not the local index', () => {
  it('renders the Last.fm lifetime count', async () => {
    const { commands, playHistoryService } = build();

    const result = await plays(commands, 'alltime');

    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalledWith('Caller', 1234, true, 'Alltime');
    expect(result).toEqual({ marker: 'plays' });
    expect(playHistoryService.getScrobbleCountFromDate).not.toHaveBeenCalled();
  });

  it('reports an unreadable Last.fm profile rather than zero scrobbles', async () => {
    const { commands } = build({ userInfo: null });

    const result = await plays(commands, 'alltime');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(PlaycountBuilders.buildPlaysResponse).not.toHaveBeenCalled();
  });

  it('renders a genuine zero for a real account that has never scrobbled', async () => {
    // The direction the null check must not swallow. A user who linked Last.fm
    // and has 0 plays is a real, answerable state, not a failed read.
    const { commands } = build({ userInfo: { playCount: 0 } });

    const result = await plays(commands, 'alltime');

    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalledWith('Caller', 0, true, 'Alltime');
    expect(result.commandResponse).not.toBe(CommandResponse.Error);
  });

  it('counts for the named target when one is given', async () => {
    const { commands, lastfmRepository } = build({
      caller: caller(),
    });

    await plays(commands, 'lfm:ghost alltime');

    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith('ghost');
  });
});

describe('.plays — a bounded period converts the window to epoch SECONDS', () => {
  it('asks for the window the settings parser produced', async () => {
    const { commands, playHistoryService } = build({
      timeSettings: settings({
        timePeriod: TimePeriod.Weekly,
        description: 'Weekly',
        startDateTime: new Date('2024-03-01T00:00:00.000Z'),
      }),
      scrobbleCount: 17,
    });

    await plays(commands, 'weekly');

    const [name, from, sessionKey, to] = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('Alpha');
    expect(from).toBe(Math.floor(new Date('2024-03-01T00:00:00.000Z').getTime() / 1000));
    // `Date.getTime()` is MILLISECONDS. Passing it straight through would ask
    // Last.fm for a window starting in 1970, which returns everything rather
    // than nothing — the most dangerous kind of wrong: a total, not a gap.
    expect(from).toBeLessThan(1e11);
    expect(sessionKey).toBe('SK');
    expect(to).toBeNull();
  });

  it('passes the window end through when the period has one', async () => {
    const { commands, playHistoryService } = build({
      timeSettings: settings({
        timePeriod: TimePeriod.Monthly,
        description: 'Monthly',
        startDateTime: new Date('2024-01-01T00:00:00.000Z'),
        endDateTime: new Date('2024-01-31T00:00:00.000Z'),
      }),
    });

    await plays(commands, 'january 2024');

    const [, from, , to] = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(from).toBe(Math.floor(new Date('2024-01-01T00:00:00.000Z').getTime() / 1000));
    expect(to).toBe(Math.floor(new Date('2024-01-31T00:00:00.000Z').getTime() / 1000));
  });

  it('sends null rather than a stale session key for an unauthenticated account', async () => {
    // A session key makes Last.fm count PRIVATE scrobbles too. Sending one that
    // belongs to a different account, or a fabricated one, changes the number.
    const { commands, playHistoryService } = build({
      caller: caller({ sessionKey: undefined }),
      timeSettings: settings({ timePeriod: TimePeriod.Weekly, description: 'Weekly' }),
    });

    await plays(commands, 'weekly');

    expect((playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeNull();
  });

  it('reports an unreadable count rather than "0 scrobbles this week"', async () => {
    const { commands } = build({
      timeSettings: settings({ timePeriod: TimePeriod.Weekly, description: 'Weekly' }),
      scrobbleCount: null,
    });

    const result = await plays(commands, 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(PlaycountBuilders.buildPlaysResponse).not.toHaveBeenCalled();
  });

  it('renders a genuine zero for a week with no plays', async () => {
    const { commands } = build({
      timeSettings: settings({ timePeriod: TimePeriod.Weekly, description: 'Weekly' }),
      scrobbleCount: 0,
    });

    const result = await plays(commands, 'weekly');

    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalledWith('Caller', 0, false, 'Weekly');
    expect(result.commandResponse).not.toBe(CommandResponse.NotFound);
  });

  it('marks the card as period-bound rather than all time', async () => {
    const { commands } = build({
      timeSettings: settings({ timePeriod: TimePeriod.Yearly, description: 'Yearly' }),
    });

    await plays(commands, 'yearly');

    expect(vi.mocked(PlaycountBuilders.buildPlaysResponse).mock.calls[0]![2]).toBe(false);
  });
});

describe('.playleaderboard and .timeleaderboard — an empty list is a claim, not a blank', () => {
  const entries: GuildLeaderboardEntry[] = [
    { discordUserId: '111', userNameLastFm: 'Alpha', displayName: 'Caller', value: 900 },
    { discordUserId: '222', userNameLastFm: 'Beta', displayName: 'Beta', value: 12 },
  ];

  it('refuses the play leaderboard outside a server', async () => {
    const { commands, playHistoryService } = build();

    const result = await playLeaderboard(commands, dmCtx());

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(playHistoryService.getGuildPlayLeaderboard).not.toHaveBeenCalled();
  });

  it('refuses the listening-time leaderboard outside a server', async () => {
    const { commands, playHistoryService } = build();

    const result = await timeLeaderboard(commands, dmCtx());

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(playHistoryService.getGuildTimeLeaderboard).not.toHaveBeenCalled();
  });

  it('ranks the guild by PLAYS and labels the unit as plays', async () => {
    const { commands } = build({ playEntries: entries });

    await playLeaderboard(commands, guildCtx());

    expect(PlaycountBuilders.buildLeaderboardResponse).toHaveBeenCalledWith({
      guildName: 'Test Guild',
      title: 'Scrobbles Leaderboard',
      unit: 'plays',
      entries,
      accentColor: 0x445566,
    });
  });

  it('ranks the guild by MINUTES, and never mixes it with the play count', async () => {
    const { commands } = build({ timeEntries: entries });

    await timeLeaderboard(commands, guildCtx());

    expect(PlaycountBuilders.buildLeaderboardResponse).toHaveBeenCalledWith({
      guildName: 'Test Guild',
      title: 'Listening Time Leaderboard',
      unit: 'minutes',
      entries,
      accentColor: 0x445566,
    });
  });

  it('renders the empty card for a guild where nobody has any indexed plays', async () => {
    // A real answer. The builder says "No members found with plays in this
    // server yet", which is true of an empty guild and only true by accident of
    // an outage — and the outage case raises instead, which is the next test.
    const { commands } = build({ playEntries: [] });

    const result = await playLeaderboard(commands, guildCtx());

    expect(result.commandResponse).not.toBe(CommandResponse.Error);
    expect(vi.mocked(PlaycountBuilders.buildLeaderboardResponse).mock.calls[0]![0]).toMatchObject({ entries: [] });
  });

  it('lets a failed database read through instead of rendering the empty card', async () => {
    const { commands, playHistoryService } = build();
    (playHistoryService.getGuildPlayLeaderboard as ReturnType<typeof vi.fn>).mockRejectedValue(dbDown());

    await expect(playLeaderboard(commands, guildCtx())).rejects.toThrow(/Database unavailable/);

    expect(PlaycountBuilders.buildLeaderboardResponse).not.toHaveBeenCalled();
  });

  it('lets a failed listening-time read through too', async () => {
    const { commands, playHistoryService } = build();
    (playHistoryService.getGuildTimeLeaderboard as ReturnType<typeof vi.fn>).mockRejectedValue(dbDown());

    await expect(timeLeaderboard(commands, guildCtx())).rejects.toThrow(/Database unavailable/);
    expect(PlaycountBuilders.buildLeaderboardResponse).not.toHaveBeenCalled();
  });

  it('registers both leaderboards with their documented aliases', () => {
    const { commands } = build();
    const plays = commands.commands.find((c) => c.name === 'playleaderboard')!;
    const times = commands.commands.find((c) => c.name === 'timeleaderboard')!;

    expect(plays.aliases).toEqual(['sblb', 'scrobblelb', 'scrobbleleaderboard']);
    expect(times.aliases).toContain('sleepscrobblers');
  });

  it('reads the guild the context is in, not the caller’s', async () => {
    const { commands, playHistoryService } = build({ playEntries: entries });

    await playLeaderboard(commands, guildCtx({ guild: { id: '999', name: 'Other', iconURL: () => 'https://img/x.png' } }));

    expect(playHistoryService.getGuildPlayLeaderboard).toHaveBeenCalledWith('999');
  });
});
