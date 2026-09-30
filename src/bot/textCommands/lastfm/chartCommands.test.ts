// `chartCommands.ts` itself carries no `@injectable()`, but it imports
// `UpdateService` and `ChartService`, which do — and tsyringe throws at module
// load without the polyfill. Rule: first import, always.
import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ChartCommands } from './chartCommands';
import { ChartBuilders } from '@bot/builders/chartBuilders';
import { ChartService, NotEnoughAlbumsError, TooManyImagesError } from '@bot/services/chartService';
import { TitleSetting, ChartSettings } from '@bot/models/chartModels';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@persistence/domain/models/user';

/**
 * `.chart` / `.aotd` / `.artistchart` / `.trackchart`.
 *
 * This file is the largest hand-written argument grammar in the two directories
 * I own: size, titles, skip, sfw, rainbow, no-singles, `r:YYYY`, `d:YYYYs`, a
 * time period and a free-text artist search, all mixed into one argument vector
 * in one pass. The grammar is the product here, so most of these tests assert
 * the resulting `ChartSettings` rather than the card.
 *
 * Two failure modes are specifically guarded, because both produce a
 * plausible-looking wrong chart rather than an error:
 *
 *  1. A token that is not removed from the argument list leaks into the time
 *     period / artist search, so `.chart sfw monthly` searches Last.fm for
 *     "sfw monthly" and silently returns the wrong library slice.
 *  2. A mentioned target must not leak the CALLER's Last.fm name into the
 *     query, and must not report the caller's display name on the card.
 *
 * The cooldown is also stateful per instance and is shared across all four
 * triggers, which is easy to get wrong when a test file builds many instances;
 * each test therefore builds a fresh one.
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

const ctx = (content: string, over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    guild: { id: '222', name: 'Test Guild' },
    message: {
      content,
      channelId: 'C1',
      author: { id: '111', username: 'caller', displayName: 'Caller' },
      member: { displayName: 'Caller' },
      guild: {
        name: 'Test Guild',
        members: { cache: new Map<string, { displayName: string }>(), fetch: vi.fn(async () => null) },
      },
    },
    ...over,
  }) as unknown as ContextModel;

type Overrides = {
  caller?: User | null;
  byDiscordId?: Record<string, User | null>;
  chartResult?: unknown;
  generateThrows?: unknown;
  accentFromBuffer?: number | null;
  accentFromUrl?: number | null;
};

const build = (over: Overrides = {}) => {
  const chartService = {
    generateAlbumChart: vi.fn(async (..._a: unknown[]) => {
      if (over.generateThrows) throw over.generateThrows;
      return over.chartResult ?? { buffer: Buffer.from('png'), imageUrl: undefined };
    }),
    generateArtistChart: vi.fn(async (..._a: unknown[]) => {
      if (over.generateThrows) throw over.generateThrows;
      return over.chartResult ?? { buffer: Buffer.from('png'), imageUrl: undefined };
    }),
    generateTrackChart: vi.fn(async (..._a: unknown[]) => {
      if (over.generateThrows) throw over.generateThrows;
      return over.chartResult ?? { buffer: Buffer.from('png'), imageUrl: undefined };
    }),
    getDimensions: vi.fn(ChartService.getDimensions),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async (...args: unknown[]) => {
      const id = args[0] as string;
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id]!;
      return id === '111' ? (over.caller === undefined ? user() : over.caller) : null;
    }),
    enqueueUserUpdate: vi.fn((..._a: unknown[]) => undefined),
  };
  const settingService = {
    getTimePeriod: vi.fn((...args: unknown[]) => {
      const raw = (args[0] as string) ?? '';
      return {
        timePeriod: 'Weekly',
        description: raw.trim() || 'Weekly',
        searchValue: '',
      };
    }),
  };
  const updateService = {
    updateUser: vi.fn(async (..._a: unknown[]) => undefined),
  };
  const colorService = {
    extractAccentColor: vi.fn(async (..._a: unknown[]) =>
      over.accentFromBuffer === undefined ? 0xaabbcc : over.accentFromBuffer,
    ),
    getColorFromImageUrl: vi.fn(async (..._a: unknown[]) =>
      over.accentFromUrl === undefined ? 0xddeeff : over.accentFromUrl,
    ),
  };

  const commands = new ChartCommands(
    chartService as never,
    userService as never,
    settingService as never,
    updateService as never,
    colorService as never,
  );

  return { commands, chartService, userService, settingService, updateService, colorService };
};

/** Run the `chart` trigger (the first registered definition). */
const run = (commands: ChartCommands, context: ContextModel, ...args: string[]) =>
  commands.commands[0]!.executeAsync(context, args);

/** Run a NAMED trigger, e.g. 'artistchart', so the twin branches are reachable. */
const runNamed = (commands: ChartCommands, name: string, content: string, ...args: string[]) => {
  const def = commands.commands.find(c => c.name === name);
  if (!def) throw new Error(`no chart trigger named ${name}`);
  return def.executeAsync(ctx(content), args);
};

const settingsOf = (chartService: { generateAlbumChart: { mock: { calls: unknown[][] } } }) =>
  chartService.generateAlbumChart.mock.calls[0]![2] as ChartSettings;

const desc = (r: { embed: { data: { description?: string } } }): string =>
  (r.embed.data.description ?? '') as string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(ChartBuilders, 'buildAlbumChartResponse').mockReturnValue({ marker: 'album' } as never);
  vi.spyOn(ChartBuilders, 'buildArtistChartResponse').mockReturnValue({ marker: 'artist' } as never);
  vi.spyOn(ChartBuilders, 'buildTrackChartResponse').mockReturnValue({ marker: 'track' } as never);
  vi.spyOn(ChartBuilders, 'buildNotEnoughAlbumsError').mockReturnValue({ marker: 'too-few' } as never);
  vi.spyOn(UpdateService, 'needsUpdate').mockReturnValue(false);
});

describe('ChartCommands — registration', () => {
  it('registers all four chart triggers', () => {
    const { commands } = build();
    expect(commands.commands.map(c => c.name)).toEqual(['chart', 'aotd', 'artistchart', 'trackchart']);
    expect(commands.commands[0]!.aliases).toContain('aoty');
    expect(commands.commands[1]!.aliases).toEqual(['albumsofthedecade', 'albumofthedecade']);
    expect(commands.commands[2]!.aliases).toEqual(['ac', 'top']);
  });

  it('sends artistchart and trackchart down their own service methods', async () => {
    const { commands, chartService } = build();

    await runNamed(commands, 'artistchart', '.artistchart', 'weekly');
    await runNamed(commands, 'trackchart', '.trackchart', 'weekly');

    expect(chartService.generateArtistChart).toHaveBeenCalledTimes(1);
    expect(chartService.generateTrackChart).toHaveBeenCalledTimes(1);
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
    expect(ChartBuilders.buildArtistChartResponse).toHaveBeenCalledTimes(1);
    expect(ChartBuilders.buildTrackChartResponse).toHaveBeenCalledTimes(1);
  });
});

describe('ChartCommands — the boolean token grammar', () => {
  it('defaults every modifier off for a bare .chart', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'weekly');

    const s = settingsOf(chartService);
    expect(s.artistChart).toBe(false);
    expect(s.trackChart).toBe(false);
    expect(s.titleSetting).toBe(TitleSetting.Titles);
    expect(s.skipWithoutImage).toBe(false);
    expect(s.skipNsfw).toBe(false);
    expect(s.rainbowSortingEnabled).toBe(false);
    expect(s.filterSingles).toBe(false);
  });

  it.each([
    ['notitles', TitleSetting.TitlesDisabled],
    ['nt', TitleSetting.TitlesDisabled],
    ['NOTITLES', TitleSetting.TitlesDisabled],
  ])('turns titles off for %j', async (token, expected) => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), token, 'weekly');

    expect(settingsOf(chartService).titleSetting).toBe(expected);
  });

  it.each(['skipemptyimages', 'skipemptyalbums', 'skipalbums', 'skip', 's'])(
    'turns skip on for %j',
    async (token) => {
      const { commands, chartService } = build();

      await run(commands, ctx('.chart'), token, 'weekly');

      expect(settingsOf(chartService).skipWithoutImage).toBe(true);
    },
  );

  it('turns sfw on', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'sfw', 'weekly');

    expect(settingsOf(chartService).skipNsfw).toBe(true);
  });

  it.each(['rainbow', 'pride'])('turns rainbow on for %j', async (token) => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), token, 'weekly');

    const s = settingsOf(chartService);
    expect(s.rainbowSortingEnabled).toBe(true);
    // Rainbow colouring a transparent cell produces a hole, so it forces skip.
    expect(s.skipWithoutImage).toBe(true);
  });

  it.each(['ns', 'nosingles', 'hidesingles', 'filtersingles'])(
    'turns singles filtering on for %j',
    async (token) => {
      const { commands, chartService } = build();

      await run(commands, ctx('.chart'), token, 'weekly');

      expect(settingsOf(chartService).filterSingles).toBe(true);
    },
  );

  it('strips every consumed token out of the period input', async () => {
    // The leak this guards: a modifier left in the argument vector is searched
    // as an artist name, and the chart silently comes back for the wrong slice.
    const { commands, settingService } = build();

    await run(commands, ctx('.chart'), 'sfw', 'notitles', 'rainbow', 'ns', 'skip', 'monthly');

    expect(settingService.getTimePeriod).toHaveBeenCalledWith('monthly');
  });
});

describe('ChartCommands — the size grammar', () => {
  it('applies a valid widthxheight', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), '4x5', 'weekly');

    const s = settingsOf(chartService);
    expect(s.width).toBe(4);
    expect(s.height).toBe(5);
  });

  it('removes the size token from the period input', async () => {
    const { commands, settingService } = build();

    await run(commands, ctx('.chart'), '4x5', 'monthly');

    expect(settingService.getTimePeriod).toHaveBeenCalledWith('monthly');
  });

  it('rejects a size over the 100-image ceiling with a usable message', async () => {
    const { commands, chartService } = build();

    const result = await run(commands, ctx('.chart'), '11x11', 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('widthxheight');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('falls back to the default size when none is given', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'weekly');

    const s = settingsOf(chartService);
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
  });
});

describe('ChartCommands — the release year and decade filters', () => {
  it.each(['r:1998', 'released:1998', 'R:1998'])('reads a release year from %j', async (token) => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), token, 'weekly');

    expect(settingsOf(chartService).releaseYearFilter).toBe(1998);
  });

  it('removes the year token from the period input', async () => {
    const { commands, settingService } = build();

    await run(commands, ctx('.chart'), 'r:1998', 'weekly');

    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
  });

  it('ignores a malformed year rather than filtering on NaN', async () => {
    const { commands, chartService, settingService } = build();

    await run(commands, ctx('.chart'), 'r:98', 'weekly');

    // `r:` demands exactly four digits, so `r:98` is not a year at all. It must
    // fall through to the search string rather than become NaN.
    expect(settingsOf(chartService).releaseYearFilter).toBeUndefined();
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('r:98 weekly');
  });

  it('expands a two-digit decade to this century', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'd:20s', 'weekly');

    expect(settingsOf(chartService).releaseDecadeFilter).toBe(2020);
  });

  it('expands a two-digit decade to last century when the number is high', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'd:70s', 'weekly');

    expect(settingsOf(chartService).releaseDecadeFilter).toBe(1970);
  });

  it('rounds a full year down to its decade', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'd:1994', 'weekly');

    expect(settingsOf(chartService).releaseDecadeFilter).toBe(1990);
  });

  it('refuses a decade in the future rather than filtering on it', async () => {
    const { commands, chartService, settingService } = build();

    await run(commands, ctx('.chart'), 'd:3020', 'weekly');

    // A future decade matches nothing, which would render an empty chart that
    // reads as "you have no albums". The VALUE is refused, and the token is
    // still consumed, so it cannot leak into the artist search either.
    expect(settingsOf(chartService).releaseDecadeFilter).toBeUndefined();
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
  });
});

describe('ChartCommands — .aoty and .aotd fill in their own window', () => {
  it('defaults .aoty to the current year', async () => {
    const { commands, chartService } = build();

    await runNamed(commands, 'chart', '.aoty');

    expect(settingsOf(chartService).releaseYearFilter).toBe(new Date().getUTCFullYear());
  });

  it('lets an explicit year beat the .aoty default', async () => {
    const { commands, chartService } = build();

    await runNamed(commands, 'chart', '.aoty', 'r:2011');

    expect(settingsOf(chartService).releaseYearFilter).toBe(2011);
  });

  it('defaults .aotd to the current decade', async () => {
    const { commands, chartService } = build();

    await runNamed(commands, 'aotd', '.aotd');

    const decade = Math.floor(new Date().getUTCFullYear() / 10) * 10;
    expect(settingsOf(chartService).releaseDecadeFilter).toBe(decade);
  });

  it('does not apply the aoty default to a plain .chart', async () => {
    const { commands, chartService } = build();

    await run(commands, ctx('.chart'), 'weekly');

    expect(settingsOf(chartService).releaseYearFilter).toBeUndefined();
  });
});

describe('ChartCommands — a mentioned target', () => {
  it('queries the mentioned users library, not the callers', async () => {
    const { commands, chartService, userService } = build({
      byDiscordId: { '999': user({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });

    await run(commands, ctx('.chart <@999> weekly'), '<@999>', 'weekly');

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('999');
    expect(chartService.generateAlbumChart.mock.calls[0]![0]).toBe('999');
    expect(chartService.generateAlbumChart.mock.calls[0]![1]).toBe('Beta');
  });

  it('removes the mention from the period input', async () => {
    const { commands, settingService } = build({
      byDiscordId: { '999': user({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });

    await run(commands, ctx('.chart <@999> weekly'), '<@999>', 'weekly');

    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
  });

  it('reports an unregistered target as NotFound and never queries', async () => {
    const { commands, chartService } = build({ byDiscordId: { '999': null } });

    const result = await run(commands, ctx('.chart <@999>'), '<@999>');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('not registered');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('does not require the caller to be registered when a target is named', async () => {
    const { commands, chartService } = build({
      caller: null,
      byDiscordId: { '999': user({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });

    await run(commands, ctx('.chart <@999>'), '<@999>');

    expect(chartService.generateAlbumChart).toHaveBeenCalledTimes(1);
  });
});

describe('ChartCommands — registration of the caller', () => {
  it('refuses a caller with no linked account', async () => {
    const { commands, chartService } = build({ caller: null });

    const result = await run(commands, ctx('.chart'), 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('register');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('queues a stats refresh for a stale user without blocking the chart', async () => {
    vi.spyOn(UpdateService, 'needsUpdate').mockReturnValue(true);
    const { commands, updateService, userService, chartService } = build();

    await run(commands, ctx('.chart'), 'weekly');

    expect(updateService.updateUser).toHaveBeenCalledWith(1, { accurateTotal: true });
    expect(chartService.generateAlbumChart).toHaveBeenCalledTimes(1);
    // The refresh is fire-and-forget: a now-playing chart must not wait on a
    // multi-page sync.
    expect(userService.enqueueUserUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves a fresh user alone', async () => {
    const { commands, updateService } = build();

    await run(commands, ctx('.chart'), 'weekly');

    expect(updateService.updateUser).not.toHaveBeenCalled();
  });
});

describe('ChartCommands — accent colour selection', () => {
  it('reads the accent out of the rendered buffer', async () => {
    const { commands, colorService } = build();

    await run(commands, ctx('.chart'), 'weekly');

    expect(colorService.extractAccentColor).toHaveBeenCalledTimes(1);
    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
  });

  it('falls back to the hosted image url when the chart is not a buffer', async () => {
    const { commands, colorService } = build({
      chartResult: { buffer: undefined, imageUrl: 'https://img/chart.png' },
    });

    await run(commands, ctx('.chart'), 'weekly');

    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/chart.png');
  });

  it('passes the accent through to the builder', async () => {
    const { commands } = build();

    await run(commands, ctx('.chart'), 'weekly');

    expect(vi.mocked(ChartBuilders.buildAlbumChartResponse).mock.calls[0]![4]).toBe(0xaabbcc);
  });

  it('works with no colour service at all', async () => {
    const { chartService, userService, settingService, updateService } = build();
    const bare = new ChartCommands(
      chartService as never,
      userService as never,
      settingService as never,
      updateService as never,
    );

    const result = await run(bare, ctx('.chart'), 'weekly');

    expect(result).toEqual({ marker: 'album' });
    expect(vi.mocked(ChartBuilders.buildAlbumChartResponse).mock.calls[0]![4]).toBeUndefined();
  });
});

describe('ChartCommands — upstream failures stay visible', () => {
  it('renders the not-enough-albums card rather than a generic error', async () => {
    const { commands } = build({ generateThrows: new NotEnoughAlbumsError(12, 50) });

    const result = await run(commands, ctx('.chart'), 'weekly');

    expect(result).toEqual({ marker: 'too-few' });
    expect(ChartBuilders.buildNotEnoughAlbumsError).toHaveBeenCalledTimes(1);
  });

  it('names the track form in the not-enough card for .trackchart', async () => {
    const { commands } = build({ generateThrows: new NotEnoughAlbumsError(12, 50) });

    await runNamed(commands, 'trackchart', '.trackchart', 'weekly');

    expect(vi.mocked(ChartBuilders.buildNotEnoughAlbumsError).mock.calls[0]![1]).toBe('track');
  });

  it('names the artist form in the not-enough card for .artistchart', async () => {
    const { commands } = build({ generateThrows: new NotEnoughAlbumsError(12, 50) });

    await runNamed(commands, 'artistchart', '.artistchart', 'weekly');

    expect(vi.mocked(ChartBuilders.buildNotEnoughAlbumsError).mock.calls[0]![1]).toBe('artist');
  });

  it('reports the 100-image ceiling as wrong input, not a crash', async () => {
    const { commands } = build({ generateThrows: new TooManyImagesError() });

    const result = await run(commands, ctx('.chart'), 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('100');
  });

  it('re-throws an unrelated defect rather than dressing it up as a chart problem', async () => {
    // Anything else is a bug, not a user input problem, and swallowing it here
    // would tell the user to shrink their chart for a crash.
    const { commands } = build({ generateThrows: new TypeError('x is not a function') });

    await expect(run(commands, ctx('.chart'), 'weekly')).rejects.toBeInstanceOf(TypeError);
    expect(ChartBuilders.buildNotEnoughAlbumsError).not.toHaveBeenCalled();
  });
});

describe('ChartCommands — the per-user cooldown', () => {
  it('allows four album charts in the window and refuses the fifth', async () => {
    const { commands, chartService } = build();

    for (let i = 0; i < 4; i++) {
      const ok = await run(commands, ctx('.chart'), 'weekly');
      expect(ok).toEqual({ marker: 'album' });
    }
    const blocked = await run(commands, ctx('.chart'), 'weekly');

    expect(blocked.commandResponse).toBe(CommandResponse.Cooldown);
    expect(chartService.generateAlbumChart).toHaveBeenCalledTimes(4);
  });

  it('allows only three artist charts in the window', async () => {
    const { commands } = build();
    const runArtist = () => runNamed(commands, 'artistchart', '.artistchart', 'weekly');

    for (let i = 0; i < 3; i++) {
      expect(await runArtist()).toEqual({ marker: 'artist' });
    }
    expect((await runArtist()).commandResponse).toBe(CommandResponse.Cooldown);
  });

  it('counts every trigger against one shared budget', async () => {
    const { commands } = build();

    for (let i = 0; i < 4; i++) {
      await run(commands, ctx('.chart'), 'weekly');
    }
    // A different trigger is still the same user, so it shares the budget.
    const other = await runNamed(commands, 'artistchart', '.artistchart', 'weekly');

    expect(other.commandResponse).toBe(CommandResponse.Cooldown);
  });

  it('does not consume the budget on a rejected request', async () => {
    const { commands } = build();

    await run(commands, ctx('.chart'), '11x11', 'weekly');
    await run(commands, ctx('.chart'), '11x11', 'weekly');

    const ok = await run(commands, ctx('.chart'), 'weekly');
    expect(ok).toEqual({ marker: 'album' });
  });
});
