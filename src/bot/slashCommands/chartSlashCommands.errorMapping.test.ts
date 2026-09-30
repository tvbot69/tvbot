/**
 * `/chart albums | artists | tracks` - the option layer over the chart pipeline.
 *
 * This file is about the two ways `/chart` can answer a question that was not
 * asked.
 *
 * 1. THE ERROR-MAPPING CATCH. `chartAsync` wraps the whole pipeline in one try
 *    and has exactly three arms (`chartSlashCommands.ts:446-456`):
 *    `NotEnoughAlbumsError` renders the "you only listened to N" card, and
 *    `TooManyImagesError` renders the 100-image cap. EVERYTHING ELSE IS RE-THROWN.
 *    That third arm is the A1 property and it is the easy one to lose: a
 *    database outage, a Discord upload failure or a bug inside the artwork
 *    cascade would otherwise render as "You have listened to 4 albums in this
 *    time period, but a chart of 9 images was requested" - a confident,
 *    specific, entirely fabricated claim about somebody's listening history.
 *    Both directions are pinned: the genuine too-few case still renders that
 *    card, and anything else still raises.
 *
 * 2. USER RESOLUTION. Four separate `NotFound` branches, all of which must stop
 *    the pipeline before a single album is read. The lfm option is the awkward
 *    one: `lfm:SomeUser` and `SomeUser` must reach the SAME lookup, and a name
 *    nobody has registered must answer "not registered" rather than quietly
 *    charting the caller.
 *
 * The `size` / `released` / `decade` option grammar is pinned too, because a
 * silently-ignored filter produces a chart that looks fine and is about the
 * wrong thing entirely - a filter the user believes is applied and is not.
 *
 * `SettingService` is the REAL class here, not a double: the period parse is
 * what decides whether the "invalid time period" arm can ever fire, and a stub
 * would let me assert a branch that production can never reach. (It cannot -
 * `TimeSettingsModel` initialises `timePeriod` to `AllTime` and every arm of
 * `getTimePeriod` assigns it, so `timeSettings.timePeriod === undefined` is
 * unreachable. That is reported separately.)
 *
 * Constructor arity, read from `chartSlashCommands.ts`, undecorated and
 * positional: chartService, userService, settingService, updateService,
 * colorService?.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ChartSlashCommands } from './chartSlashCommands';
import { NotEnoughAlbumsError, TooManyImagesError } from '@bot/services/chartService';
import { SettingService } from '@bot/services/settingService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ChartService } from '@bot/services/chartService';
import type { UserService } from '@bot/services/userService';
import type { UpdateService } from '@bot/services/updateService';
import type { ColorService } from '@bot/services/colorService';

const DB_DOWN = () => new Error("Can't reach database server");

const CALLER = {
  userId: 7,
  userNameLastFm: 'DreadRock',
  discordUserId: 'caller1',
  // Fresh enough that `UpdateService.needsUpdate` is false unless a test says
  // otherwise, so the fire-and-forget resync is not noise in every other test.
  lastUpdate: new Date(),
  totalPlayCount: 4321,
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return (
      response.componentsV2Container.toJSON() as { components: Array<{ content?: string }> }
    )
      .components.map((c) => c.content ?? '')
      .join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface CtxSpec {
  sub?: string;
  strings?: Record<string, string | undefined>;
  booleans?: Record<string, boolean | undefined>;
  users?: Record<string, { id: string; username: string }>;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const guild = {
    id: '222',
    name: 'Loud Room',
    // `members.fetch` exists on the real Collection and `resolveChartUser`
    // awaits it inside a try/catch, so the double provides it as a resolving
    // promise rather than leaving the branch to a synchronous TypeError.
    members: { cache: { get: () => undefined }, fetch: async () => null },
  };
  return {
    discordUserId: 'caller1',
    guildId: '222',
    guild,
    member: { displayName: 'Caller' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guild,
      member: { displayName: 'Caller' },
      user: { id: 'caller1', username: 'caller' },
      options: {
        getSubcommand: () => spec.sub ?? 'albums',
        getString: (name: string) => spec.strings?.[name] ?? null,
        getBoolean: (name: string) => spec.booleans?.[name] ?? null,
        getUser: (name: string) => spec.users?.[name] ?? null,
      },
    },
    userIsGuildAdmin: false,
  } as unknown as ContextModel;
};

interface Doubles {
  caller?: unknown;
  byDiscordId?: Record<string, unknown>;
  byLastFmName?: Record<string, unknown>;
  albumImpl?: (...args: unknown[]) => Promise<unknown>;
  artistImpl?: (...args: unknown[]) => Promise<unknown>;
  trackImpl?: (...args: unknown[]) => Promise<unknown>;
  colorFromUrl?: number;
}

const build = (over: Doubles = {}) => {
  // `(...args: unknown[]) => ...` and not `() => ...`: a zero-arg `vi.fn` infers
  // an EMPTY call tuple, which makes `mock.calls[0][2]` a compile error vitest
  // never reports.
  const ok = async (..._args: unknown[]) => ({ imageUrl: 'https://img.test/chart.png' });
  const chartService = {
    generateAlbumChart: vi.fn(over.albumImpl ?? ok),
    generateArtistChart: vi.fn(over.artistImpl ?? ok),
    generateTrackChart: vi.fn(over.trackImpl ?? ok),
  } as unknown as ChartService;
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id];
      return over.caller === undefined ? CALLER : over.caller;
    }),
    getUserByLastFmName: vi.fn(async (name: string) =>
      over.byLastFmName ? (over.byLastFmName[name] ?? null) : null,
    ),
    enqueueUserUpdate: vi.fn(),
  } as unknown as UserService;
  // The real period parser: the `timeSettings.timePeriod === undefined` arm of
  // `buildSettings` is only reachable with a stub, and a test that only passes
  // with a stub is a test about the stub.
  const settingService = new SettingService();
  const updateService = { updateUser: vi.fn(async () => undefined) } as unknown as UpdateService;
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => over.colorFromUrl ?? 0x123456),
    extractAccentColor: vi.fn(async () => 0x654321),
  } as unknown as ColorService;

  const cmd = new ChartSlashCommands(
    chartService,
    userService,
    settingService,
    updateService,
    colorService,
  );
  return { cmd, chartService, userService, settingService, updateService, colorService };
};

type Handlers = { executeAsync(c: ContextModel): Promise<ResponseModel> };
const run = (cmd: ChartSlashCommands, ctx: ContextModel) =>
  (cmd as unknown as Handlers).executeAsync(ctx);

describe('ChartSlashCommands routing: each subcommand asks for its own chart', () => {
  it('albums reaches generateAlbumChart', async () => {
    const { cmd, chartService } = build();
    await run(cmd, makeCtx({ sub: 'albums' }));
    expect(chartService.generateAlbumChart).toHaveBeenCalledTimes(1);
    expect(chartService.generateArtistChart).not.toHaveBeenCalled();
    expect(chartService.generateTrackChart).not.toHaveBeenCalled();
  });

  it('artists reaches generateArtistChart', async () => {
    const { cmd, chartService } = build();
    await run(cmd, makeCtx({ sub: 'artists' }));
    expect(chartService.generateArtistChart).toHaveBeenCalledTimes(1);
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('tracks reaches generateTrackChart, and the chart says so', async () => {
    const { cmd, chartService } = build();
    const response = await run(cmd, makeCtx({ sub: 'tracks' }));
    expect(chartService.generateTrackChart).toHaveBeenCalledTimes(1);
    expect(cardText(response)).toContain('3x3');
  });

  it('passes the resolved discord id and Last.fm name, not the caller\'s, when a target is named', async () => {
    const { cmd, chartService } = build({
      byDiscordId: { other1: { userId: 9, userNameLastFm: 'SomeUser', discordUserId: 'other1' } },
    });
    await run(cmd, makeCtx({ sub: 'albums', users: { user: { id: 'other1', username: 'other' } } }));

    expect(chartService.generateAlbumChart).toHaveBeenCalledWith('other1', 'SomeUser', expect.anything());
  });
});

describe('ChartSlashCommands user resolution: nobody reads an album before the user is known', () => {
  it('refuses a Discord target who has not registered, and reads nothing', async () => {
    const { cmd, chartService } = build({ byDiscordId: { other1: null } });
    const response = await run(
      cmd,
      makeCtx({ sub: 'albums', users: { user: { id: 'other1', username: 'other' } } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('is not registered with the bot');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('refuses an lfm option naming a stranger', async () => {
    const { cmd, chartService } = build({ byLastFmName: {} });
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { lfm: 'NobodyHere' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('NobodyHere');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('strips the `lfm:` prefix before looking the name up', async () => {
    const { cmd, chartService, userService } = build({
      byLastFmName: {
        SomeUser: { userId: 9, userNameLastFm: 'SomeUser', discordUserId: 'other1' },
      },
    });
    await run(cmd, makeCtx({ sub: 'albums', strings: { lfm: 'lfm:SomeUser' } }));

    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('SomeUser');
    expect(chartService.generateAlbumChart).toHaveBeenCalledWith('other1', 'SomeUser', expect.anything());
  });

  it('refuses a caller who has never connected an account', async () => {
    const { cmd, chartService } = build({ caller: null });
    const response = await run(cmd, makeCtx({ sub: 'albums' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });
});

describe('ChartSlashCommands option grammar: a silently-ignored filter charts the wrong thing', () => {
  it('refuses a size that is not WIDTHxHEIGHT', async () => {
    const { cmd, chartService } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { size: 'big' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Invalid chart size');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('refuses a size over the 100-image cap', async () => {
    // `getDimensions` returns `changed: false` for 11x11 (121 images) as well as
    // for nonsense, so both land in the same arm - and neither may quietly fall
    // back to 3x3, which would hand the user a chart they did not ask for.
    const { cmd, chartService } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { size: '11x11' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('up to 100 total images');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('accepts a valid size and puts it on the card', async () => {
    const { cmd } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { size: '4x2' } }));
    expect(cardText(response)).toContain('4x2');
  });

  it('refuses a `released` value that is not a four-digit year', async () => {
    const { cmd, chartService } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { released: 'the nineties' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('four-digit year');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('accepts a four-digit release year', async () => {
    const { cmd, chartService } = build();
    await run(cmd, makeCtx({ sub: 'albums', strings: { released: '1997' } }));

    const settings = (chartService.generateAlbumChart as ReturnType<typeof vi.fn>).mock.calls[0]![2] as {
      releaseYearFilter?: number;
    };
    expect(settings.releaseYearFilter).toBe(1997);
  });

  it('accepts `1990s` and expands it to the decade start', async () => {
    const { cmd, chartService } = build();
    await run(cmd, makeCtx({ sub: 'albums', strings: { decade: '1990s' } }));

    const settings = (chartService.generateAlbumChart as ReturnType<typeof vi.fn>).mock.calls[0]![2] as {
      releaseDecadeFilter?: number;
    };
    expect(settings.releaseDecadeFilter).toBe(1990);
  });

  it('CHARACTERISATION: `90s` is rejected by a regex that demands four digits', async () => {
    // The refusal text promises "`1990` or `90s`", and the guard is
    // `/^\d{4}s?$/i`, so the exact example the user is told to type is the one
    // form that does not work. Reported separately; pinned here so the
    // contradiction is visible rather than re-derived.
    const { cmd, chartService } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { decade: '90s' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('`1990` or `90s`');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('refuses a decade it cannot read rather than charting every album', async () => {
    const { cmd, chartService } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { decade: 'last year' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('`1990` or `90s`');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('turns rainbow on and forces skipWithoutImage with it', async () => {
    // A silent mode where the builder colours covers but the missing-cover skip
    // stays off would render holes the user never asked for.
    const { cmd, chartService } = build();
    await run(cmd, makeCtx({ sub: 'albums', booleans: { rainbow: true } }));

    const settings = (chartService.generateAlbumChart as ReturnType<typeof vi.fn>).mock.calls[0]![2] as {
      rainbowSortingEnabled: boolean;
      skipWithoutImage: boolean;
    };
    expect(settings.rainbowSortingEnabled).toBe(true);
    expect(settings.skipWithoutImage).toBe(true);
  });
});

describe('ChartSlashCommands error mapping: only two failures get a card', () => {
  it('renders the "you only listened to N" card for a genuine NotEnoughAlbumsError', async () => {
    const { cmd } = build({
      albumImpl: async (..._args: unknown[]) => {
        throw new NotEnoughAlbumsError(4, 9);
      },
    });
    const response = await run(cmd, makeCtx({ sub: 'albums' }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    const text = cardText(response);
    expect(text).toContain('listened to **4** albums');
    expect(text).toContain('chart of **9** images');
  });

  it('names ARTISTS on the artists subcommand, not albums', async () => {
    // The card asserts a fact about somebody's listening history. Saying "4
    // albums" on an artist chart would be a fabricated number dressed as a real
    // one, and it is one ternary away.
    const { cmd } = build({
      artistImpl: async (..._args: unknown[]) => {
        throw new NotEnoughAlbumsError(2, 9);
      },
    });
    const text = cardText(await run(cmd, makeCtx({ sub: 'artists' })));
    expect(text).toContain('listened to **2** artists');
    expect(text).not.toContain('albums');
  });

  it('names TRACKS on the tracks subcommand', async () => {
    const { cmd } = build({
      trackImpl: async (..._args: unknown[]) => {
        throw new NotEnoughAlbumsError(1, 9);
      },
    });
    const text = cardText(await run(cmd, makeCtx({ sub: 'tracks' })));
    expect(text).toContain('listened to **1** tracks');
  });

  it('adds the after-filters advice only when the shortfall happened after filtering', async () => {
    const plain = build({
      albumImpl: async (..._args: unknown[]) => {
        throw new NotEnoughAlbumsError(4, 9, false);
      },
    });
    const filtered = build({
      albumImpl: async (..._args: unknown[]) => {
        throw new NotEnoughAlbumsError(4, 9, true);
      },
    });

    expect(cardText(await run(plain.cmd, makeCtx({ sub: 'albums' })))).not.toContain('remained after filters');
    expect(cardText(await run(filtered.cmd, makeCtx({ sub: 'albums' })))).toContain('remained after filters');
  });

  it('renders the 100-image cap for TooManyImagesError', async () => {
    const { cmd } = build({
      albumImpl: async (..._args: unknown[]) => {
        throw new TooManyImagesError('too many');
      },
    });
    const response = await run(cmd, makeCtx({ sub: 'albums' }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('limited to 100 total images');
  });

  it('re-throws anything else instead of dressing it up as "you listened to 4 albums"', async () => {
    // THE A1 TEST. A `catch (err) { return buildNotEnoughAlbumsError(...) }`
    // rewrite of that third arm turns every database outage, upload failure and
    // artwork-cascade bug into a specific and completely invented claim about
    // somebody's listening history.
    const { cmd } = build({
      albumImpl: async (..._args: unknown[]) => {
        throw DB_DOWN();
      },
    });
    const settled = await run(cmd, makeCtx({ sub: 'albums' })).then(
      (r) => r,
      (e: unknown) => e,
    );

    expect(settled).toBeInstanceOf(Error);
    expect(String(settled)).toMatch(/database server/i);
    expect(String(settled)).not.toContain('listened to');
  });
});

describe('ChartSlashCommands: the resync is fire-and-forget and never blocks the chart', () => {
  it('kicks off an accurate-total resync for a stale user and still returns the chart', async () => {
    const { cmd, chartService, updateService } = build({
      caller: { ...CALLER, lastUpdate: undefined },
    });
    const response = await run(cmd, makeCtx({ sub: 'albums' }));

    expect(updateService.updateUser).toHaveBeenCalledWith(7, { accurateTotal: true });
    expect(chartService.generateAlbumChart).toHaveBeenCalledTimes(1);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('does not resync a user whose index is fresh', async () => {
    const { cmd, updateService } = build();
    await run(cmd, makeCtx({ sub: 'albums' }));
    expect(updateService.updateUser).not.toHaveBeenCalled();
  });
});

describe('ChartSlashCommands: the Edit button on a chart card', () => {
  it('CHARACTERISATION: the button carries no creator id, so nobody can ever press it', async () => {
    // `chartAsync` builds `author` as `{ userNameLastFm, totalPlayCount }` and
    // casts it to `User`; `ChartBuilders` then reads `user.discordUserId` for the
    // `chart-edit:` customId, which is therefore the literal string "undefined".
    // `ChartInteractions.handleEditButton` compares `interaction.user.id` with
    // that field and refuses anyone who does not match, so the control is dead
    // for every user including the chart's creator. Reported separately; pinned
    // here so the fix has to change this test on purpose.
    const { cmd } = build();
    const response = await run(cmd, makeCtx({ sub: 'albums' }));

    const json = JSON.stringify(response.componentsV2Container?.toJSON());
    expect(json).toContain('chart-edit:');
    expect(json).toContain('chart-edit:undefined:a:');
  });
});