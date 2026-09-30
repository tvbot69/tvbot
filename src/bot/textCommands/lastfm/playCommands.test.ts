import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';

import { PlayCommands } from './playCommands';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { RecentBuilders } from '@bot/builders/recentBuilders';
import { FmSettingService } from '@bot/services/fmSettingService';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { ChannelRepository } from '@persistence/repositories/channelRepository';
import { PrefixService } from '@bot/services/prefixService';
import { ArtworkService } from '@bot/services/artworkService';
import { ColorService } from '@bot/services/colorService';
import { ExposedService } from '@bot/services/exposedService';
import { FmFooterResolver } from '@bot/services/fmFooterResolver';
import { UpdateService } from '@bot/services/updateService';
import { FmEmbedType } from '@domain/enums/fmEmbedType';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack, RecentTrackList } from '@domain/models/recentTrack';

/**
 * `.fm` / `.recent` / `.register` / `.fmmode`.
 *
 * Two module-level facts dominate this file and both are invisible from the
 * class alone:
 *
 *  1. `cooldownMap` is a MODULE-level Map that persists for the whole process
 *     and is never pruned. A Last.fm read charges it and nothing else does, so
 *     the tests below use a distinct `channelId:discordUserId` key per test —
 *     the only reliable way to isolate them, since nothing exports the map.
 *     Two suites depend on that distinction being real and they are opposites:
 *     a real `.fm` spends a token, `.fm help` spends none.
 *  2. `fmAsync` reaches for ArtworkService, PrefixService, FmSettingService,
 *     GuildRepository, ChannelRepository, ColorService and ExposedService
 *     through `container.resolve`, and it calls `container.isRegistered` for
 *     the last one. So `container.resolve` is mocked from a token→double
 *     table, and an unmapped token THROWS rather than returning undefined —
 *     a silent undefined would let the test pass while the real code path was
 *     never taken.
 *
 * On failure handling: the presentation reads (fm setting, guild embed type,
 * channel embed type) are deliberately wrapped in a try/catch and degrade to
 * null, and the 4K-nostalgia gag is deliberately swallowed. Those are
 * documented decisions, so the tests assert the DEGRADED answer is still a real
 * now-playing card with real Last.fm numbers, not that it throws.
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

const track = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Weird Fishes',
  artistName: 'Radiohead',
  albumName: 'In Rainbows',
  imageUrl: 'https://img/real.jpg',
  nowPlaying: true,
  ...over,
});

const trackList = (tracks: RecentTrack[], over: Partial<RecentTrackList> = {}): RecentTrackList => ({
  tracks,
  totalPages: 4,
  totalScrobbles: 400,
  ...over,
});

/**
 * Distinct channel ids keep each test out of the previous test's cooldown.
 *
 * `fmAsync` keys the cooldown on `context.message?.channelId`, NOT the
 * normalised `context.channelId` getter, so `ctx({ channelId })` below has to
 * write through to the message as well. Setting only the getter leaves every
 * test sharing the key `C1:111` and the second one is refused — which reads
 * like a command bug and is actually a mock bug.
 */
let channelSeq = 0;
const nextChannel = () => `C${++channelSeq}`;

const ctx = (over: Record<string, unknown> = {}): ContextModel => {
  const channelId = (over.channelId as string) ?? 'C1';
  return {
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    channelId,
    message: {
      channelId,
      author: { id: '111', username: 'caller', displayName: 'Caller' },
      member: { displayName: 'Caller' },
      guild: { members: { cache: new Map<string, { displayName: string }>() } },
    },
    ...over,
  } as unknown as ContextModel;
};

type Overrides = {
  caller?: User | null;
  byDiscordId?: Record<string, User | null>;
  byLastFmName?: Record<string, User | null>;
  tracks?: RecentTrack[] | null;
  tracksWithMetadata?: RecentTrackList | null;
  userInfo?: unknown;
  albumCover?: string | null;
  trackCover?: string | null;
  fmSetting?: unknown;
  guildFmType?: number | null;
  channelFmType?: number | null;
  accentColor?: number | null;
  anomaly?: unknown;
  exposedRegistered?: boolean;
  presentationThrows?: boolean;
};

const build = (over: Overrides = {}) => {
  const me = over.caller === undefined ? caller() : over.caller;

  const userService = {
    getUserByDiscordId: vi.fn(async (...args: unknown[]) => {
      const id = args[0] as string;
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id]!;
      return id === '111' ? me : null;
    }),
    getUserByLastFmName: vi.fn(async (...args: unknown[]) =>
      (over.byLastFmName?.[args[0] as string] as User | undefined) ?? null,
    ),
    setUserLastFm: vi.fn(async (..._a: unknown[]) => caller()),
  };
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) =>
      over.tracks === undefined ? [track()] : over.tracks,
    ),
    getUserRecentTracksWithMetadata: vi.fn(async (..._a: unknown[]) =>
      over.tracksWithMetadata === undefined ? trackList([track()]) : over.tracksWithMetadata,
    ),
    // `in` rather than `??`: `userInfo: null` is a MEANINGFUL value here (the
    // Last.fm user does not exist) and `null ?? default` would silently replace
    // it, making the "could not find that user" branch untestable.
    getUserInfo: vi.fn(async (..._a: unknown[]) =>
      'userInfo' in over ? over.userInfo : { name: 'Alpha', playcount: 5000 },
    ),
  };
  const updateService = { updateUser: vi.fn(async (..._a: unknown[]) => undefined) };

  // A Map, not an object literal. The keys are CLASS CONSTRUCTORS, and
  // TypeScript only accepts `string | number | symbol | any` as a computed
  // property name — `typeof ArtworkService` is none of those, so
  // `Record<unknown, unknown>` with `[ArtworkService]: …` is 9 compile errors.
  // `npm test` passed anyway; only `tsc` saw it. That is the sixth time this
  // repo has produced a green suite over a red build.
  const tokens = new Map<unknown, Record<string, unknown>>([
    [
      ArtworkService,
      {
        getAlbumCoverUrl: vi.fn(async (..._a: unknown[]) =>
          over.albumCover === undefined ? null : over.albumCover,
        ),
        getTrackCoverUrl: vi.fn(async (..._a: unknown[]) =>
          over.trackCover === undefined ? null : over.trackCover,
        ),
      },
    ],
    [PrefixService, { getPrefix: vi.fn(async (..._a: unknown[]) => '!') }],
    [
      ColorService,
      {
        getColorFromImageUrl: vi.fn(async (..._a: unknown[]) =>
          over.accentColor === undefined ? 0x556677 : over.accentColor,
        ),
      },
    ],
    [
      FmSettingService,
      {
        get: vi.fn(async (..._a: unknown[]) => {
          if (over.presentationThrows) throw new Error('database unavailable');
          return 'fmSetting' in over ? over.fmSetting : null;
        }),
        getOrCreate: vi.fn(async (..._a: unknown[]) =>
          over.fmSetting ?? { embedType: 1, footerOptions: 16n, buttons: 0n, smallTextType: null },
        ),
      },
    ],
    [
      GuildRepository,
      {
        getGuild: vi.fn(async (..._a: unknown[]) => {
          if (over.presentationThrows) throw new Error('database unavailable');
          return over.guildFmType === undefined ? null : { fmEmbedType: over.guildFmType };
        }),
      },
    ],
    [
      ChannelRepository,
      {
        getChannel: vi.fn(async (..._a: unknown[]) => {
          if (over.presentationThrows) throw new Error('database unavailable');
          return over.channelFmType === undefined ? null : { fmEmbedType: over.channelFmType };
        }),
      },
    ],
    [
      ExposedService,
      {
        checkLiveNowPlayingAnomaly: vi.fn(async (..._a: unknown[]) => {
          if (over.anomaly instanceof Error) throw over.anomaly;
          return over.anomaly ?? null;
        }),
      },
    ],
  ]);

  const commands = new PlayCommands(
    userService as never,
    lastfmRepository as never,
    updateService as never,
  );

  return { commands, userService, lastfmRepository, updateService, tokens };
};

const named = (c: PlayCommands, name: string) => {
  const def = c.commands.find(d => d.name === name);
  if (!def) throw new Error(`no trigger named ${name}`);
  return def;
};

const runFm = (c: PlayCommands, context: ContextModel, options = '') =>
  named(c, 'fm').executeAsync(context, options ? [options] : []);

const runRecent = (c: PlayCommands, context: ContextModel, options = '') =>
  named(c, 'recent').executeAsync(context, options ? [options] : []);

const desc = (r: { embed: { data: { description?: string } } }): string =>
  (r.embed.data.description ?? '') as string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // `mockReturnValue` hands the SAME object to every call, and the 4K-gag path
  // MUTATES `response.content` on it — a shared instance would let one test's
  // joke line leak into the next assertion. `mockImplementation` builds a new one.
  vi.spyOn(PlayBuilders, 'buildFmResponse').mockImplementation(
    (..._a: unknown[]) => ({ marker: 'fm', content: undefined }) as never,
  );
  vi.spyOn(PlayBuilders, 'buildRegisterSuccessResponse').mockReturnValue({ marker: 'register' } as never);
  vi.spyOn(PlayBuilders, 'buildFmModeResponse').mockReturnValue({ marker: 'mode' } as never);
  vi.spyOn(RecentBuilders, 'buildRecentTracksResponse').mockReturnValue({ marker: 'recent' } as never);
  vi.spyOn(FmFooterResolver, 'resolveFooterData').mockResolvedValue({} as never);
  vi.spyOn(UpdateService, 'needsUpdate').mockReturnValue(false);
  vi.spyOn(container, 'isRegistered').mockReturnValue(false);
  vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
    throw new Error(`container.resolve not stubbed for ${String(token)}`);
  });
});

/** Install the token table for one test; unmapped tokens still throw. */
const withTokens = (tokens: Map<unknown, Record<string, unknown>>) => {
  vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) => {
    if (tokens.has(token)) return tokens.get(token) as never;
    throw new Error(`unexpected container token: ${String(token)}`);
  }) as never);
};

// `vi.mocked` rather than reaching for `.mock` on the export. The export is
// declared as a plain function, so `.mock` is a compile error even after
// `vi.spyOn` replaced it at runtime. `vi.mocked` is the type-level cast for
// exactly this, and it keeps the assertion reading the same.
const fmSpy = () => vi.mocked(PlayBuilders.buildFmResponse);
const recentSpy = () => vi.mocked(RecentBuilders.buildRecentTracksResponse);

const fmOpts = (call: number) => fmSpy().mock.calls[call]![4] as Record<string, unknown>;

describe('PlayCommands — registration', () => {
  it('registers fm, recent, register and fmmode', () => {
    const { commands } = build();
    expect(commands.commands.map(c => c.name)).toEqual(['fm', 'recent', 'register', 'fmmode']);
    expect(commands.commands[0]!.aliases).toContain('np');
    expect(commands.commands[1]!.aliases).toContain('history');
    expect(commands.commands[3]!.aliases).toEqual(['fmsettings']);
  });
});

describe('PlayCommands — the per-channel cooldown', () => {
  it('refuses a second .fm in the same channel inside the window', async () => {
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);
    const context = ctx({ channelId: nextChannel(), message: { channelId: 'Cx' } });

    await runFm(commands, context);
    const second = await runFm(commands, context);

    expect(second.commandResponse).toBe(CommandResponse.Cooldown);
    expect(desc(second as never)).toContain('cooldown');
    // The half that makes this a real quota guard rather than a displayed
    // error: the refusal short-circuits, so the second call spends nothing on
    // Last.fm either. One token, one read.
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledTimes(1);
  });

  it('does not refuse a different channel for the same user', async () => {
    const { commands, tokens } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }));
    const elsewhere = await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(elsewhere).toEqual({ marker: 'fm' });
  });

  it('does not refuse a different user in the same channel', async () => {
    const { commands, tokens } = build({
      // `999` must be a REGISTERED user: the cooldown key is per
      // channel:discordId, but a different Discord id also means a different
      // account lookup, and an unregistered one is refused for that reason
      // rather than reaching the card.
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });
    withTokens(tokens);
    const channelId = nextChannel();

    await runFm(commands, ctx({ channelId }));
    // A different Discord id in the SAME channel is a different cooldown key.
    const other = await runFm(
      commands,
      ctx({
        channelId,
        discordUserId: '999',
        message: {
          channelId,
          author: { id: '999', username: 'other', displayName: 'Other' },
          member: { displayName: 'Other' },
          guild: { members: { cache: new Map<string, { displayName: string }>() } },
        },
      }),
    );

    expect(other).toEqual({ marker: 'fm' });
  });

  it('still charges a request whose only argument is a layout token', async () => {
    // The other half of the "what is a Last.fm call" question. `tiny` is a
    // PRESENTATION argument, but `.fm tiny` still reads the caller's now
    // playing from Last.fm, so it is a real call and it is charged like one.
    // Pinned because "the token is local, so this is not a Last.fm call" is
    // exactly the reasoning that would have exempted it.
    const { commands, tokens } = build();
    withTokens(tokens);
    const context = ctx({ channelId: nextChannel() });

    await runFm(commands, context, 'tiny');
    const second = await runFm(commands, context);

    expect(second.commandResponse).toBe(CommandResponse.Cooldown);
  });

  it('does not cool down outside a guild', async () => {
    const { commands, tokens } = build();
    withTokens(tokens);
    const context = ctx({ guildId: undefined });

    await runFm(commands, context);
    const second = await runFm(commands, context);

    expect(second).toEqual({ marker: 'fm' });
  });
});

describe('PlayCommands — .fm help', () => {
  it('answers with usage and reads no tracks', async () => {
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }), 'help');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('fm');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('uses the guild prefix so the usage line matches the server', async () => {
    const { commands, tokens } = build();
    withTokens(tokens);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }), 'HELP');

    expect(desc(result as never)).toContain('!fm');
  });

  it('is never refused, whatever token a real .fm has already spent', async () => {
    // `.fm help` reads static text: it is the one branch in `fmAsync` that asks
    // Last.fm nothing. So it is not charged AND not checked — the cooldown
    // guards the Last.fm quota, and "you're on cooldown" is simply the wrong
    // answer to "how do I use this command". The bug this pins: the check ran
    // before the help branch, so a help request issued right after a real `.fm`
    // was refused even though it cost nothing.
    const { commands, tokens } = build();
    withTokens(tokens);
    const context = ctx({ channelId: nextChannel() });

    await runFm(commands, context);
    const help = await runFm(commands, context, 'help');

    expect(help.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(help as never)).toContain('fm');
  });

  it('spends no token of its own', async () => {
    // The other direction, and the one that regresses silently: while help was
    // charged, a user who read the usage could not read their own now playing
    // for three seconds afterwards, having called Last.fm once — through the
    // help command. The counterpart of the cooldown suite's "refuses a second
    // .fm", and both have to hold or the cooldown is charging nothing at all.
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);
    const context = ctx({ channelId: nextChannel() });

    await runFm(commands, context, 'help');
    const card = await runFm(commands, context);

    expect(card).toEqual({ marker: 'fm' });
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledTimes(1);
  });
});

describe('PlayCommands — .fm target grammar', () => {
  it('refuses a caller with no linked account', async () => {
    const { commands, tokens, lastfmRepository } = build({ caller: null });
    withTokens(tokens);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('register');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('shows another registered members now playing', async () => {
    const { commands, tokens, lastfmRepository } = build({
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), '<@999>');

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Beta', 2);
    expect(fmOpts(0)).toMatchObject({ differentUser: true });
    expect(fmSpy().mock.calls[0]![1]).toMatchObject({ userNameLastFm: 'Beta' });
  });

  it('reports an unregistered mention by id', async () => {
    const { commands, tokens, lastfmRepository } = build({ byDiscordId: { '999': null } });
    withTokens(tokens);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }), '<@999>');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('999');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('reads an external lfm: user with no database row at all', async () => {
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), 'lfm:External');

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('External', 5);
    // The fake user carries the caller's account but the external name, so the
    // embed is attributed correctly without a `User` row.
    expect(fmSpy().mock.calls[0]![1]).toMatchObject({ userNameLastFm: 'External' });
    expect(fmOpts(0)).toMatchObject({ differentUser: true, guildFmType: null, channelFmType: null });
  });

  it('reports an lfm: user that does not exist', async () => {
    const { commands, tokens } = build({ tracks: [], userInfo: null });
    withTokens(tokens);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }), 'lfm:Nobody');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('Nobody');
    expect(PlayBuilders.buildFmResponse).not.toHaveBeenCalled();
  });

  it('passes the callers session key so a private library is readable', async () => {
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }));

    // Own account: (name, 2, page 1, undefined, sessionKey).
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 2, 1, undefined, 'SK');
  });
});

describe('PlayCommands — .fm inline embed type', () => {
  it('applies a lone layout token and strips it from the target grammar', async () => {
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), 'tiny');

    expect(fmOpts(0)).toMatchObject({ inlineEmbedType: FmEmbedType.EmbedTiny });
    // The token must not survive into the Last.fm lookup.
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 2, 1, undefined, 'SK');
  });

  it('applies a layout token that FOLLOWS a mention, and strips it from the target', async () => {
    // The bug this replaces asserted the opposite: `parseFmEmbedType` was
    // called on the WHOLE argument string and it only matches a bare token, so
    // `.fm <@123> mini` parsed to null, the branch was skipped, and the request
    // was silently dropped — the user asked for a mini embed and got the
    // default. The layout token is the TAIL of the argument list, the same
    // shape `lfm:` is read with two lines below.
    const { commands, tokens, lastfmRepository } = build({
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), '<@999> mini');

    expect(fmOpts(0)).toMatchObject({ inlineEmbedType: FmEmbedType.EmbedMini, differentUser: true });
    // Stripped, not merely applied: the mention still resolves to the mentioned
    // account, and the layout word reaches neither the lookup nor the name.
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Beta', 2);
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledTimes(1);
  });

  it('changes NOTHING when the argument after the mention is not a layout token', async () => {
    // The opposite, and it is what stops the fix from becoming a shredder: a
    // strip that matched loosely would eat the first word of a real name.
    const { commands, tokens, lastfmRepository } = build({
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), '<@999> Radiohead');

    expect(fmOpts(0)).toMatchObject({ inlineEmbedType: null, differentUser: true });
    // The full name of the mentioned account, not a prefix of it and not the
    // trailing word.
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Beta', 2);
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledTimes(1);
  });

  it('applies a layout token after an lfm: name, leaving the name whole', async () => {
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), 'lfm:Radiohead tiny');

    expect(fmOpts(0)).toMatchObject({ inlineEmbedType: FmEmbedType.EmbedTiny, differentUser: true });
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Radiohead', 5);
  });

  it('never strips a token out of a username that merely CONTAINS a layout word', async () => {
    // `mini`, `full` and `text` are all real Last.fm usernames, and a name can
    // start with one. Under a loose `options.replace(/mini/i, '')` these become
    // `lfm:` and `lfm:disco`, the target parses as empty, and the command
    // quietly falls through to the CALLER's own account — a wrong track for a
    // valid request, with no error anywhere.
    const { commands, tokens, lastfmRepository } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }), 'lfm:mini');
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('mini', 5);
    expect(fmOpts(0)).toMatchObject({ inlineEmbedType: null });

    await runFm(commands, ctx({ channelId: nextChannel() }), 'lfm:minidisco');
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('minidisco', 5);
    expect(fmOpts(1)).toMatchObject({ inlineEmbedType: null });
  });
});

describe('PlayCommands — .fm presentation reads degrade without losing the track', () => {
  it('renders a full card with default styling when every presentation read fails', async () => {
    // fmSetting / guildFmType / channelFmType are presentation only. A database
    // outage must cost the STYLE, never the playcount, so the card is still
    // built from the two Last.fm reads that sit outside the try.
    const { commands, tokens, lastfmRepository } = build({ presentationThrows: true });
    withTokens(tokens);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(result).toEqual({ marker: 'fm' });
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledTimes(1);
    expect(fmOpts(0)).toMatchObject({ fmSetting: null, guildFmType: null, channelFmType: null });
  });

  it('passes the configured guild and channel embed types through when they exist', async () => {
    const { commands, tokens } = build({
      fmSetting: { embedType: 4, footerOptions: 16n, smallTextType: null, buttons: 0n },
      guildFmType: 1,
      channelFmType: 2,
    });
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(fmOpts(0)).toMatchObject({ guildFmType: 1, channelFmType: 2 });
    expect(fmOpts(0).fmSetting).toMatchObject({ embedType: 4 });
  });
});

describe('PlayCommands — .fm artwork enrichment', () => {
  it('replaces a Last.fm placeholder with a real cover', async () => {
    const { commands, tokens, lastfmRepository } = build({
      tracks: [track({ imageUrl: 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' })],
      albumCover: 'https://img/album.jpg',
    });
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(tokens.get(ArtworkService)!.getAlbumCoverUrl).toHaveBeenCalledWith('In Rainbows', 'Radiohead');
    const enriched = (await lastfmRepository.getUserRecentTracks.mock.results[0]!.value)[0]!;
    expect(enriched.imageUrl).toBe('https://img/album.jpg');
  });

  it('clears a placeholder the cascade cannot resolve, rather than showing it', async () => {
    const { commands, tokens, lastfmRepository } = build({
      tracks: [track({ imageUrl: 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' })],
    });
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }));

    const enriched = (await lastfmRepository.getUserRecentTracks.mock.results[0]!.value)[0]!;
    expect(enriched.imageUrl).toBeUndefined();
  });

  it('still builds the card when artwork resolution throws', async () => {
    const { commands, tokens } = build();
    withTokens(tokens);
    // The `as` is required: the Map's value type is `Record<string, unknown>`,
    // so `getAlbumCoverUrl` is `unknown` and `vi.mocked` rejects it. Naming the
    // shape is the whole fix — the alternative is loosening the Map to `any`,
    // which would un-typecheck every other token in the table.
    vi.mocked(tokens.get(ArtworkService)!.getAlbumCoverUrl as (...a: unknown[]) => Promise<unknown>)
      .mockRejectedValue(new Error('artwork down'));

    const result = await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(result).toEqual({ marker: 'fm' });
  });
});

describe('PlayCommands — .fm 4K nostalgia gag', () => {
  it('does not run the check when ExposedService is not registered', async () => {
    const { commands, tokens } = build();
    withTokens(tokens);

    await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(tokens.get(ExposedService)!.checkLiveNowPlayingAnomaly).not.toHaveBeenCalled();
  });

  it('adds the joke line when the check matches', async () => {
    const { commands, tokens } = build({
      anomaly: { roast: 'still playing it in 2026', matchedGenre: 'Britpop' },
    });
    withTokens(tokens);
    vi.spyOn(container, 'isRegistered').mockReturnValue(true);

    await runFm(commands, ctx({ channelId: nextChannel() }));

    const response = fmSpy().mock.results[0]!.value as { content?: string };
    expect(response.content).toContain('CAUGHT IN 4K');
    expect(response.content).toContain('Britpop');
  });

  it('keeps the now-playing card when the gag check throws', async () => {
    // A gag must never be the reason a now-playing fails. The embed was already
    // built from committed Last.fm reads before this point.
    const { commands, tokens } = build({ anomaly: new Error('exposed db down') });
    withTokens(tokens);
    vi.spyOn(container, 'isRegistered').mockReturnValue(true);

    const result = await runFm(commands, ctx({ channelId: nextChannel() }));

    expect(result).toEqual({ marker: 'fm' });
  });
});

describe('PlayCommands — .register', () => {
  it('links a username that Last.fm recognises', async () => {
    const { commands, userService } = build();

    const result = await named(commands, 'register').executeAsync(ctx(), ['NewName']);

    expect(lastfm_getUserInfo(commands)).toHaveBeenCalledWith('NewName');
    expect(userService.setUserLastFm).toHaveBeenCalledWith('111', 'NewName');
    expect(result).toEqual({ marker: 'register' });
  });

  it('rejects a missing username', async () => {
    const { commands, userService } = build();

    const result = await named(commands, 'register').executeAsync(ctx(), []);

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(userService.setUserLastFm).not.toHaveBeenCalled();
  });

  it('rejects a username longer than the Last.fm limit', async () => {
    const { commands, userService } = build();

    const result = await named(commands, 'register').executeAsync(ctx(), ['x'.repeat(256)]);

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(userService.setUserLastFm).not.toHaveBeenCalled();
  });

  it('does not link a username Last.fm does not know', async () => {
    const { commands, userService } = build({ userInfo: null });

    const result = await named(commands, 'register').executeAsync(ctx(), ['Ghost']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('Ghost');
    expect(userService.setUserLastFm).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace off the username', async () => {
    const { commands, userService } = build();

    await named(commands, 'register').executeAsync(ctx(), ['  Padded  ']);

    expect(userService.setUserLastFm).toHaveBeenCalledWith('111', 'Padded');
  });
});

/** The repository double is closed over inside `build`, so reach it via a spy. */
const lastfm_getUserInfo = (c: PlayCommands) =>
  (c as unknown as { lastfmRepository: { getUserInfo: ReturnType<typeof vi.fn> } }).lastfmRepository
    .getUserInfo;

describe('PlayCommands — .fmmode', () => {
  it('answers with the stored layout for a registered caller', async () => {
    const { commands, tokens } = build({
      fmSetting: { embedType: 2, footerOptions: 16n, buttons: 0n, smallTextType: 0 },
    });
    withTokens(tokens);

    const result = await named(commands, 'fmmode').executeAsync(ctx(), []);

    expect(result).toEqual({ marker: 'mode' });
    expect(tokens.get(FmSettingService)!.getOrCreate).toHaveBeenCalledWith(1);
  });

  it('refuses an unregistered caller and names the register command', async () => {
    const { commands, tokens } = build({ caller: null });
    withTokens(tokens);

    const result = await named(commands, 'fmmode').executeAsync(ctx(), []);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('.register');
    expect(tokens.get(FmSettingService)!.getOrCreate).not.toHaveBeenCalled();
  });
});

describe('PlayCommands — .recent target grammar', () => {
  it('refuses an unregistered caller', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await runRecent(commands, ctx());

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('reads the callers own history by default', async () => {
    const { commands, lastfmRepository, tokens } = build();
    withTokens(tokens);

    const result = await runRecent(commands, ctx());

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'Alpha', 6, 1, undefined, 'SK',
    );
    expect(result).toEqual({ marker: 'recent' });
  });

  it('treats a bare number as a page, clamped to 1..80', async () => {
    const { commands, lastfmRepository, tokens } = build();
    withTokens(tokens);

    await runRecent(commands, ctx(), '3');
    expect(lastfmRepository.getUserRecentTracksWithMetadata.mock.calls[0]![2]).toBe(3);

    await runRecent(commands, ctx(), '999');
    expect(lastfmRepository.getUserRecentTracksWithMetadata.mock.calls[1]![2]).toBe(80);

    await runRecent(commands, ctx(), '0');
    expect(lastfmRepository.getUserRecentTracksWithMetadata.mock.calls[2]![2]).toBe(1);
  });

  it('reads a mentioned member history and names them from the guild cache', async () => {
    const { commands, lastfmRepository, tokens } = build({
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });
    withTokens(tokens);
    const context = ctx({
      message: {
        channelId: 'C1',
        author: { id: '111', username: 'caller', displayName: 'Caller' },
        member: { displayName: 'Caller' },
        guild: { members: { cache: new Map([['999', { displayName: 'Beta In Guild' }]]) } },
      },
    });

    await runRecent(commands, context, '<@999>');

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'Beta', 6, 1, undefined, 'SK',
    );
    expect(recentSpy().mock.calls[0]![1]).toBe('Beta In Guild');
  });

  it('drops the session key for an lfm: target that has no linked account', async () => {
    const { commands, lastfmRepository, tokens } = build();
    withTokens(tokens);

    await runRecent(commands, ctx(), 'lfm:External');

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'External', 6, 1, undefined, undefined,
    );
  });

  it('resolves a registered member by Last.fm name', async () => {
    const { commands, lastfmRepository, tokens } = build({
      byLastFmName: { 'other person': caller({ userId: 8, discordUserId: '888', userNameLastFm: 'other person' }) },
    });
    withTokens(tokens);

    await runRecent(commands, ctx(), 'other person');

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'other person', 6, 1, undefined, 'SK',
    );
    expect(recentSpy().mock.calls[0]![2]).toBe('888');
  });

  it('treats an unknown name as a raw external query, not a failure', async () => {
    const { commands, lastfmRepository, tokens } = build();
    withTokens(tokens);

    await runRecent(commands, ctx(), 'some stranger');

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalledWith(
      'some stranger', 6, 1, undefined, undefined,
    );
  });

  it('reports a user with no scrobbles as NotFound', async () => {
    const { commands, tokens } = build({ tracksWithMetadata: trackList([]) });
    withTokens(tokens);

    const result = await runRecent(commands, ctx());

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('No scrobbles');
    expect(RecentBuilders.buildRecentTracksResponse).not.toHaveBeenCalled();
  });

  it('refreshes a stale users stats in the background without blocking', async () => {
    vi.spyOn(UpdateService, 'needsUpdate').mockReturnValue(true);
    const { commands, updateService, tokens } = build();
    withTokens(tokens);

    await runRecent(commands, ctx());

    expect(updateService.updateUser).toHaveBeenCalledWith(1, { accurateTotal: true });
  });
});
