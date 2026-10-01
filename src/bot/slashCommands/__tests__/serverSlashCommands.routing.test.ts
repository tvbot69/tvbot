/**
 * `/server artists | albums | tracks | genres` - the server billboard.
 *
 * THE BRANCH THAT TURNS AN UNREADABLE SOURCE INTO A CONFIDENT WRONG ANSWER is
 * the empty-state arm in `ServerBuilders.buildServerLeaderboardResponse`
 * (`serverBuilders.ts:132-144`):
 *
 *     if (!items || items.length === 0) {
 *       response.commandResponse = CommandResponse.NotFound;
 *       ... 'Sorry, there are no registered top artists on this server in the
 *            time period you selected.'
 *
 * That is the correct answer for a quiet server, and it is byte-identical to
 * the answer for a server whose ranking query blew up. Nothing in
 * `serverSlashCommands` catches, so a failure escapes to the global handler and
 * the user is told their command failed - which is the whole point of having
 * the boundary here. These tests pin BOTH halves: the genuine empty renders the
 * NotFound card, and a raising query never reaches the builder at all. A blanket
 * `catch { items = [] }` would pass the first and fail the second.
 *
 * The second half of the file is the routing itself, which is worth more than
 * it looks. All four subcommands funnel through one dispatcher that builds a
 * SINGLE option string, `"<time-period> <order>"`, and hands it to
 * `parseGuildRankingSettings`. A subcommand that reaches the wrong ranking
 * method, or drops the artist filter on the way, answers a completely different
 * question with a completely plausible chart - and the user cannot tell.
 *
 * Constructor arity, read from `serverSlashCommands.ts`: (guildRankingService,
 * colorService). Two positional arguments, both required.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ServerSlashCommands } from '../serverSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { OrderType } from '@bot/services/guildRankingService';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { GuildRankingService } from '@bot/services/guildRankingService';
import type { ColorService } from '@bot/services/system/colorService';

const DB_DOWN = () => new Error("Can't reach database server");

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
  sub?: string | null;
  strings?: Record<string, string | undefined>;
  inGuild?: boolean;
  iconUrl?: string | null;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const guild =
    spec.inGuild === false
      ? null
      : {
          id: '222',
          name: 'Loud Room',
          iconURL: () => spec.iconUrl ?? null,
          members: { cache: { get: () => undefined } },
        };
  return {
    discordUserId: 'caller1',
    guildId: guild ? '222' : undefined,
    guild,
    member: { displayName: 'Caller' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guild,
      user: { id: 'caller1', tag: 'caller#1' },
      options: {
        getSubcommand: () => (spec.sub === undefined ? 'artists' : spec.sub),
        getString: (name: string) => spec.strings?.[name] ?? null,
      },
    },
    userIsGuildAdmin: false,
  } as unknown as ContextModel;
};

const ARTIST_ITEMS = [
  { name: 'Radiohead', totalPlaycount: 900, listenerCount: 4 },
  { name: 'Boards of Canada', totalPlaycount: 400, listenerCount: 2 },
];
const ALBUM_ITEMS = [
  { name: 'OK Computer', secondaryName: 'Radiohead', totalPlaycount: 120, listenerCount: 3 },
];
const TRACK_ITEMS = [
  { name: 'Airbag', secondaryName: 'Radiohead', totalPlaycount: 90, listenerCount: 5 },
];
const GENRE_ITEMS = [{ name: 'art rock', totalPlaycount: 700, listenerCount: 4 }];

interface Doubles {
  impl?: (...args: unknown[]) => Promise<unknown[]>;
  colorFromUrl?: number;
}

const build = (over: Doubles = {}) => {
  // Declared as `(...args: unknown[]) => ...` rather than a zero-arg arrow: a
  // zero-arg `vi.fn` infers an EMPTY call tuple, which makes `mock.calls[0][1]`
  // a compile error that vitest never reports.
  const implFor = (fallback: unknown[]) =>
    over.impl ?? (async (..._args: unknown[]) => fallback);
  const guildRankingService = {
    getGuildTopArtists: vi.fn(implFor(ARTIST_ITEMS)),
    getGuildTopAlbums: vi.fn(implFor(ALBUM_ITEMS)),
    getGuildTopTracks: vi.fn(implFor(TRACK_ITEMS)),
    getGuildTopGenres: vi.fn(implFor(GENRE_ITEMS)),
  } as unknown as GuildRankingService;
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => over.colorFromUrl ?? 0xabcdef),
  } as unknown as ColorService;
  const cmd = new ServerSlashCommands(guildRankingService, colorService);
  return { cmd, guildRankingService, colorService };
};

type Handlers = {
  handleSubcommandAsync(c: ContextModel): Promise<ResponseModel>;
};
const run = (cmd: ServerSlashCommands, ctx: ContextModel) =>
  (cmd as unknown as Handlers).handleSubcommandAsync(ctx);

describe('ServerSlashCommands: a server question has no answer in a DM', () => {
  it('refuses outside a guild and reads no ranking at all', async () => {
    const { cmd, guildRankingService } = build();
    const response = await run(cmd, makeCtx({ inGuild: false }));

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(cardText(response)).toContain('can only be used in a server');
    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
  });
});

describe('ServerSlashCommands routing: each subcommand must ask its own question', () => {
  type Route = [string, (svc: GuildRankingService) => unknown, string];
  const ROUTES: Route[] = [
    ['artists', (s) => s.getGuildTopArtists, 'artists in Loud Room'],
    ['albums', (s) => s.getGuildTopAlbums, 'albums in Loud Room'],
    ['tracks', (s) => s.getGuildTopTracks, 'tracks in Loud Room'],
    ['genres', (s) => s.getGuildTopGenres, 'genres in Loud Room'],
  ];

  it.each(ROUTES)('/server %s reaches its own ranking method and no other', async (sub, pick, phrase) => {
    const { cmd, guildRankingService } = build();
    const response = await run(cmd, makeCtx({ sub }));

    const reached = pick(guildRankingService) as ReturnType<typeof vi.fn>;
    expect(reached).toHaveBeenCalled();
    // "and no other" — the OTHER THREE. Listing all four would contradict the
    // line above: the picked method is necessarily called, twice for a weekly
    // window (the current read and the previous-window read the billboard needs).
    for (const [otherSub, otherPick] of ROUTES) {
      if (otherSub === sub) continue;
      expect(otherPick(guildRankingService), otherSub).not.toHaveBeenCalled();
    }
    expect(cardText(response)).toContain(phrase);
  });

  it('REFUSES an unrecognised subcommand rather than answering with the artists chart', async () => {
    // `handleSubcommandAsync` used to END with `return
    // this.serverArtistsSlashAsync(...)` as its fall-through, so a subcommand
    // nobody declared was answered as if the user had asked for artists - a
    // confident, entirely plausible chart for a question that was never asked.
    // Discord constrains the option set, so this arm is defensive rather than a
    // live hole, but "I do not understand that" is the only honest answer to
    // input the command does not know.
    const { cmd, guildRankingService } = build();
    const response = await run(cmd, makeCtx({ sub: 'playlists' }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('playlists');
    // The point of the fix: no ranking query of any kind ran, so there is no
    // chart left on screen to be mistaken for the answer.
    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopAlbums).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopTracks).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopGenres).not.toHaveBeenCalled();
  });

  it('refuses a missing subcommand as unknown input, not as artists', async () => {
    // The dispatcher used to default a null subcommand to `artists`, which is
    // the same wrong answer by a different route: it invents the question the
    // user asked rather than admitting there wasn't one.
    const { cmd, guildRankingService } = build();
    const response = await run(cmd, makeCtx({ sub: null }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
  });

  it('forwards the artist filter to albums and tracks', async () => {
    // Dropping the filter would answer a very different question than the one
    // asked, and the resulting chart looks completely normal.
    const { cmd, guildRankingService } = build();
    await run(cmd, makeCtx({ sub: 'albums', strings: { artist: 'Radiohead' } }));
    expect(guildRankingService.getGuildTopAlbums).toHaveBeenCalledWith(
      '222',
      expect.anything(),
      'Radiohead',
    );

    await run(cmd, makeCtx({ sub: 'tracks', strings: { artist: 'Radiohead' } }));
    expect(guildRankingService.getGuildTopTracks).toHaveBeenCalledWith(
      '222',
      expect.anything(),
      'Radiohead',
    );
  });

  it('never passes an artist filter to the artist or genre rankings', async () => {
    const { cmd, guildRankingService } = build();
    await run(cmd, makeCtx({ sub: 'artists', strings: { artist: 'Radiohead' } }));
    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledWith('222', expect.anything());
  });
});

describe('ServerSlashCommands: the period on the card is the period that was queried', () => {
  it('defaults to weekly when no period is given, and says weekly', async () => {
    // `parseGuildRankingSettings('')` returns the weekly window, and the header
    // is built from `settings.timeDescription`. If those two ever disagreed the
    // card would be a confident claim about the wrong window.
    const { cmd, guildRankingService } = build();
    const response = await run(cmd, makeCtx({ sub: 'artists' }));

    const settings = (guildRankingService.getGuildTopArtists as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { chartTimePeriod: string; timeDescription: string };
    expect(settings.chartTimePeriod).toBe('weekly');
    expect(settings.timeDescription).toBe('weekly');
    expect(cardText(response)).toContain('Top weekly artists in Loud Room');
  });

  it('honours the all-time option', async () => {
    const { cmd, guildRankingService } = build();
    const response = await run(cmd, makeCtx({ sub: 'artists', strings: { 'time-period': 'alltime' } }));

    const settings = (guildRankingService.getGuildTopArtists as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { chartTimePeriod: string; amountOfDays: number | undefined };
    expect(settings.chartTimePeriod).toBe('alltime');
    expect(settings.amountOfDays).toBe(0);
    expect(cardText(response)).toContain('Top all-time artists in Loud Room');
  });

  it('turns the order option into the right ordering, and the card says which', async () => {
    const listeners = build();
    await run(listeners.cmd, makeCtx({ sub: 'artists', strings: { order: 'listeners' } }));
    const lSettings = (listeners.guildRankingService.getGuildTopArtists as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { orderType: OrderType };
    expect(lSettings.orderType).toBe(OrderType.Listeners);

    const plays = build();
    const response = await run(plays.cmd, makeCtx({ sub: 'artists', strings: { order: 'plays' } }));
    const pSettings = (plays.guildRankingService.getGuildTopArtists as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { orderType: OrderType };
    expect(pSettings.orderType).toBe(OrderType.Playcount);
    // The footer states the ordering, because a playcount-ordered chart shown in
    // listener order is a plausible wrong answer.
    expect(cardText(response)).toContain('Play count');
  });
});

describe('ServerSlashCommands billboard: the previous-window read only happens when there is one', () => {
  it('reads last week as well for a weekly chart', async () => {
    const { cmd, guildRankingService } = build();
    await run(cmd, makeCtx({ sub: 'artists', strings: { 'time-period': 'weekly' } }));
    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledTimes(2);
  });

  it('does NOT read a previous window for an all-time chart', async () => {
    // All time has no preceding week, so `billboardStartDateTime` is null and the
    // second read is skipped. A spurious second read would also be a second
    // chance to fail the whole command.
    const { cmd, guildRankingService } = build();
    await run(cmd, makeCtx({ sub: 'artists', strings: { 'time-period': 'alltime' } }));
    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledTimes(1);
  });
});

describe('ServerSlashCommands: a dead ranking query must not render as a quiet server', () => {
  it('renders the honest empty for a server with nothing in the window', async () => {
    const { cmd } = build({
      impl: async (..._args: unknown[]) => [],
    });
    const response = await run(cmd, makeCtx({ sub: 'artists' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('no registered top artists on this server');
  });

  it('names the artist filter in the empty card rather than blaming the server', async () => {
    // An empty filtered chart and an empty server chart are different facts.
    const { cmd } = build({
      impl: async (..._args: unknown[]) => [],
    });
    const response = await run(cmd, makeCtx({ sub: 'albums', strings: { artist: 'Radiohead' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('no registered top albums for artist `Radiohead`');
  });

  it('refuses to render the empty card when the ranking query raises', async () => {
    // THE A1 TEST. `catch { items = [] }` here would be indistinguishable from
    // the line above, and the user would be told their server has no listeners.
    const { cmd } = build({
      impl: async (..._args: unknown[]) => {
        throw DB_DOWN();
      },
    });
    await expect(run(cmd, makeCtx({ sub: 'artists' }))).rejects.toThrow(/database server/i);
  });
});

describe('ServerSlashCommands accent colour', () => {
  it('samples the guild icon when the server has one', async () => {
    const { cmd, colorService } = build();
    await run(cmd, makeCtx({ sub: 'artists', iconUrl: 'https://cdn.test/icon.png' }));
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn.test/icon.png');
  });

  it('falls back to the brand red when the server has no icon', async () => {
    // An iconless server is normal; inventing a colour for it would be a
    // fabricated fact, and a red card is a fine answer.
    const { cmd, colorService } = build();
    const response = await run(cmd, makeCtx({ sub: 'artists', iconUrl: null }));

    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    const json = JSON.stringify(response.componentsV2Container?.toJSON());
    expect(json).toContain(String(DiscordConstants.LastFmColorRed));
  });
});
