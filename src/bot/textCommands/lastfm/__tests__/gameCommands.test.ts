import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GameCommands } from '@bot/textCommands/lastfm/gameCommands';
import { GameBuilders } from '@bot/builders/gameBuilders';
import { isPlaceholderImageUrl } from '@bot/services/media/artworkService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { JumbleSession, UserGameStats } from '@bot/services/guild/gameService';

/**
 * `.jumble` / `.pixel` / `.gamestats` — the text half of the game pair.
 *
 * These modules parse no grammar and compute nothing: they check a guild, check
 * an account, pick a target out of Last.fm's top list, hand it to GameService
 * and delegate the card. So the assertions that matter are the GUARDS (DM,
 * unregistered, already-running, empty library) and the DELEGATION (the right
 * artist/album is chosen and the right builder is called with it). A guard that
 * answers Ok instead of refusing is a real defect: the user is told a game
 * started when none did.
 *
 * The `stats` sub-form is the one branch that must NOT read Last.fm or start a
 * game, and it is reachable by a substring of free text, so it gets its own
 * coverage in both spellings.
 */

const REGISTERED = { userId: 1, discordUserId: '111', userNameLastFm: 'Alpha', sessionKey: 'SK' };

const stats = (over: Partial<UserGameStats> = {}): UserGameStats => ({
  totalPlayed: 10,
  totalWon: 4,
  streak: 2,
  bestStreak: 5,
  avgTimeSeconds: 12,
  ...over,
});

const session = (over: Partial<JumbleSession> = {}): JumbleSession => ({
  sessionId: 'sess1',
  channelId: 'C1',
  guildId: '222',
  starterUserId: 'Alpha',
  starterDiscordId: '111',
  type: 'artist',
  correctAnswer: 'Radiohead',
  displayTarget: 'R********d',
  artistName: 'Radiohead',
  dateStarted: new Date(),
  hints: [],
  hintsShown: 0,
  blurLevel: 0,
  reshuffles: 0,
  ended: false,
  ...over,
});

/** A collector double: `on('collect', fn)` is the only hook the command uses. */
const mkCollector = () => {
  const handlers = new Map<string, (msg: unknown) => Promise<void> | void>();
  const collector = {
    on: vi.fn((event: string, fn: (msg: unknown) => Promise<void> | void) => {
      handlers.set(event, fn);
      return collector;
    }),
    stop: vi.fn(),
    async emit(msg: unknown): Promise<void> {
      await handlers.get('collect')?.(msg);
    },
  };
  return collector;
};

const mkChannel = (collector: ReturnType<typeof mkCollector> | null) => ({
  id: 'C1',
  send: vi.fn(async (..._a: unknown[]) => undefined),
  ...(collector ? { createMessageCollector: vi.fn(() => collector) } : {}),
});

const mkMsg = (over: Record<string, unknown> = {}) => ({
  content: 'Radiohead',
  author: { id: '222', username: 'bob', bot: false },
  member: { displayName: 'Bob' },
  channel: { send: vi.fn(async (..._a: unknown[]) => undefined) },
  react: vi.fn(async (..._a: unknown[]) => undefined),
  ...over,
});

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { id: '222', name: 'Test Guild' },
    channelId: 'C1',
    prefix: '.',
    discordDisplayName: 'Caller',
    ...over,
  }) as unknown as ContextModel;

const dmCtx = () => ctx({ guildId: undefined, guild: null, channelId: null, guildIdOrNull: undefined });

type Overrides = {
  caller?: User | null;
  topArtists?: unknown[] | null;
  topAlbums?: unknown[] | null;
  active?: JumbleSession | undefined;
  accentColor?: number | null;
  albumCover?: string | null;
  collector?: ReturnType<typeof mkCollector> | null;
};

const build = (over: Overrides = {}) => {
  const caller = over.caller === undefined ? (REGISTERED as User) : over.caller;
  const collector = over.collector === undefined ? mkCollector() : over.collector;

  const userService = {
    getUserByDiscordId: vi.fn(async (..._a: unknown[]) => caller),
  };
  const lastfmRepository = {
    getTopArtists: vi.fn(async (..._a: unknown[]) =>
      over.topArtists === undefined
        ? ([{ name: 'Radiohead', playcount: 900, mbid: 'm' }] as unknown[])
        : over.topArtists,
    ),
    getTopAlbums: vi.fn(async (..._a: unknown[]) =>
      over.topAlbums === undefined
        ? ([
            { name: 'OK Computer', artistName: 'Radiohead', playcount: 400, imageUrl: 'https://img/real.jpg' },
          ] as unknown[])
        : over.topAlbums,
    ),
  };
  const gameService = {
    getUserStats: vi.fn((..._a: unknown[]) => stats()),
    getActiveGame: vi.fn((..._a: unknown[]) => over.active),
    startGame: vi.fn((..._a: unknown[]) => session()),
    setCollector: vi.fn((..._a: unknown[]) => undefined),
    giveUp: vi.fn((..._a: unknown[]) => session({ ended: true })),
    checkAnswer: vi.fn((..._a: unknown[]) => ({ isCorrect: false })),
    pixelateCover: vi.fn(async (..._a: unknown[]) => Buffer.from('pixels')),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async (..._a: unknown[]) =>
      over.accentColor === undefined ? 0x112233 : over.accentColor,
    ),
  };
  const artworkService = {
    getAlbumCoverUrl: vi.fn(async (..._a: unknown[]) =>
      over.albumCover === undefined ? 'https://img/cascade.jpg' : over.albumCover,
    ),
  };

  const commands = new GameCommands(
    userService as never,
    lastfmRepository as never,
    gameService as never,
    colorService as never,
    artworkService as never,
  );

  return { commands, userService, lastfmRepository, gameService, colorService, artworkService, collector };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(GameBuilders, 'buildGameStatsResponse').mockReturnValue({ marker: 'stats' } as never);
  vi.spyOn(GameBuilders, 'buildJumbleStartResponse').mockReturnValue({ marker: 'jumble' } as never);
  vi.spyOn(GameBuilders, 'buildPixelStartResponse').mockReturnValue({ marker: 'pixel' } as never);
  vi.spyOn(GameBuilders, 'buildGameGiveUpResponse').mockReturnValue({ componentsV2Container: { g: 1 } } as never);
  vi.spyOn(GameBuilders, 'buildGameWonResponse').mockReturnValue({ componentsV2Container: { w: 1 } } as never);
  vi.spyOn(GameBuilders, 'buildGameExpiredResponse').mockReturnValue({ componentsV2Container: { e: 1 } } as never);
});

describe('GameCommands — command registration', () => {
  it('registers jumble, pixel and gamestats with their documented aliases', () => {
    const { commands } = build();

    const names = commands.commands.map(c => c.name);
    expect(names).toEqual(['jumble', 'pixel', 'gamestats']);

    const jumble = commands.commands[0]!;
    expect(jumble.aliases).toEqual(['jmbl', 'jum', 'jumbmle']);
    expect(commands.commands[1]!.aliases).toContain('pixelation');
    expect(commands.commands[2]!.aliases).toEqual(['js', 'pxs']);
  });
});

describe('GameCommands.jumbleAsync — guards that must actually refuse', () => {
  it('refuses in a DM without reading Last.fm or starting a game', async () => {
    const { commands, lastfmRepository, gameService } = build();

    const result = await commands.jumbleAsync(dmCtx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    // The refusal is only real if nothing downstream ran.
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('refuses a caller with no linked Last.fm account', async () => {
    const { commands, gameService } = build({ caller: null });

    const result = await commands.jumbleAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('.register');
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('refuses to start a second game in a channel that already has a live one', async () => {
    const { commands, gameService } = build({ active: session({ ended: false }) });

    const result = await commands.jumbleAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.Cooldown);
    expect(result.embed.data.description).toContain('give up');
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('reports an empty library instead of building a puzzle from nothing', async () => {
    const { commands, gameService } = build({ topArtists: [] });

    const result = await commands.jumbleAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('top artists');
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('reports "no suitable artists" when every name is filtered out, not a crash', async () => {
    // Two-character name fails the >= 3 length floor; a leading '.' would make
    // it a command instead of an answer.
    const { commands } = build({ topArtists: [{ name: 'XX', playcount: 1 }, { name: '.hidden', playcount: 1 }] });

    const result = await commands.jumbleAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('suitable artists');
  });
});

describe('GameCommands.jumbleAsync — the happy path delegates', () => {
  it('asks Last.fm for a wide top-artist list and starts a session for the chosen artist', async () => {
    const { commands, lastfmRepository, gameService, colorService } = build();

    const result = await commands.jumbleAsync(ctx(), '');

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('Alpha', undefined, 250);
    expect(gameService.startGame).toHaveBeenCalledTimes(1);

    const params = gameService.startGame.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      channelId: 'C1',
      guildId: '222',
      starterUserId: 'Alpha',
      starterDiscordId: '111',
      type: 'artist',
      correctAnswer: 'Radiohead',
      artistName: 'Radiohead',
    });
    // The expiry hook is a live function, not a placeholder: the timer calls it.
    expect(typeof params.onExpire).toBe('function');

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('222');
    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledTimes(1);
    expect(vi.mocked(GameBuilders.buildJumbleStartResponse).mock.calls[0]![1]).toBe(0x112233);
    expect(result).toEqual({ marker: 'jumble' });
  });

  it('opens a collector on the game channel and hands it to the service', async () => {
    const { commands, gameService, collector } = build();

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');

    expect(gameService.setCollector).toHaveBeenCalledWith('sess1', collector);
  });

  it('survives a channel that cannot host a collector rather than throwing', async () => {
    // `createMessageCollector` only exists on a text channel. The session must
    // still start, because a missing collector is a missing convenience, not a
    // reason to deny the user their game.
    const { commands, gameService } = build();

    const result = await commands.jumbleAsync(ctx({ channel: { id: 'C1', send: vi.fn() } }), '');

    expect(result).toEqual({ marker: 'jumble' });
    expect(gameService.startGame).toHaveBeenCalledTimes(1);
    expect(gameService.setCollector).not.toHaveBeenCalled();
  });
});

describe('GameCommands — the stats sub-form never starts a game', () => {
  it.each(['stats', 'statistics', 'STATS', 'my statistics'])(
    'answers with the stats card for %j without reading Last.fm',
    async (options) => {
      const { commands, lastfmRepository, gameService } = build();

      const result = await commands.jumbleAsync(ctx(), options);

      expect(GameBuilders.buildGameStatsResponse).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ marker: 'stats' });
      expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
      expect(gameService.startGame).not.toHaveBeenCalled();
    },
  );

  it('still refuses the stats sub-form in a DM — the guild guard comes first', async () => {
    const { commands } = build();

    const result = await commands.jumbleAsync(dmCtx(), 'stats');

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(GameBuilders.buildGameStatsResponse).not.toHaveBeenCalled();
  });
});

describe('GameCommands.gameStatsAsync', () => {
  it('builds the card from the live stats, naming the caller', async () => {
    const { commands, gameService } = build();

    const result = await commands.gameStatsAsync(ctx(), '');

    expect(gameService.getUserStats).toHaveBeenCalledWith('111');
    expect(GameBuilders.buildGameStatsResponse).toHaveBeenCalledWith('Caller', stats(), 0x112233);
    expect(result).toEqual({ marker: 'stats' });
  });

  it('works without a linked account, because stats are local to the Discord id', async () => {
    // gameStatsAsync never checks the caller, unlike its siblings. That is
    // deliberate: a player with no Last.fm link still has a Discord-scoped
    // win/loss record, and demanding an account would hide it.
    const { commands } = build({ caller: null });

    const result = await commands.gameStatsAsync(ctx(), '');

    expect(result).toEqual({ marker: 'stats' });
  });

  it('returns a null accent outside a guild rather than calling the colour service', async () => {
    const { commands, colorService } = build();

    await commands.gameStatsAsync(ctx({ guild: null }), '');

    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
    expect(vi.mocked(GameBuilders.buildGameStatsResponse).mock.calls[0]![2]).toBeNull();
  });
});

describe('GameCommands.pixelAsync — artwork is filtered, not trusted', () => {
  it('refuses when the library has no album with usable cover art', async () => {
    const { commands, gameService } = build({
      topAlbums: [
        { name: 'No Art', artistName: 'X', imageUrl: undefined },
        { name: 'Placeholder', artistName: 'X', imageUrl: `https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png` },
      ],
    });

    const result = await commands.pixelAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('cover artwork');
    expect(gameService.pixelateCover).not.toHaveBeenCalled();
  });

  it('keeps the Last.fm cover when the artwork cascade returns a placeholder', async () => {
    const { commands, artworkService, gameService } = build({
      albumCover: `https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png`,
    });

    await commands.pixelAsync(ctx(), '');

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('OK Computer', 'Radiohead');
    // The placeholder is exactly what the eligibility filter exists to reject,
    // so accepting it back would undo the filter.
    expect(isPlaceholderImageUrl(gameService.pixelateCover.mock.calls[0]![0] as string)).toBe(false);
    expect(gameService.pixelateCover.mock.calls[0]![0]).toBe('https://img/real.jpg');
  });

  it('prefers a real cascade cover over the raw Last.fm url', async () => {
    const { commands, gameService } = build({ albumCover: 'https://img/cascade.jpg' });

    await commands.pixelAsync(ctx(), '');

    expect(gameService.pixelateCover).toHaveBeenCalledWith('https://img/cascade.jpg', 0.04);
  });

  it('starts a pixel session carrying the album, artist and cover', async () => {
    const { commands, gameService } = build();

    await commands.pixelAsync(ctx(), '');

    expect(gameService.startGame).toHaveBeenCalledTimes(1);
    expect(gameService.startGame.mock.calls[0]![0]).toMatchObject({
      type: 'pixel',
      correctAnswer: 'OK Computer',
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      coverUrl: 'https://img/cascade.jpg',
    });
    expect(GameBuilders.buildPixelStartResponse).toHaveBeenCalledTimes(1);
  });

  it('refuses a second game in the same channel', async () => {
    const { commands } = build({ active: session({ ended: false }) });

    const result = await commands.pixelAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.Cooldown);
    expect(GameBuilders.buildPixelStartResponse).not.toHaveBeenCalled();
  });
});

describe('GameCommands — the collector resolves a game', () => {
  it('replies with the give-up card and stops the collector on "give up"', async () => {
    const { commands, gameService, collector } = build();

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    await collector!.emit(mkMsg({ content: '  GIVE UP  ' }));

    expect(gameService.giveUp).toHaveBeenCalledWith('sess1');
    expect(collector!.stop).toHaveBeenCalledWith('given_up');
    expect(GameBuilders.buildGameGiveUpResponse).toHaveBeenCalledTimes(1);
    // A give-up is not a win: no win card, no tick.
    expect(GameBuilders.buildGameWonResponse).not.toHaveBeenCalled();
  });

  it.each(['give up', 'giveup', 'quit', 'QUIT'])('treats %j as giving up', async (text) => {
    const { commands, gameService, collector } = build();

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    await collector!.emit(mkMsg({ content: text }));

    expect(gameService.giveUp).toHaveBeenCalledWith('sess1');
  });

  it('ignores an empty message entirely', async () => {
    const { commands, gameService, collector } = build();

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    await collector!.emit(mkMsg({ content: '   ' }));

    expect(gameService.checkAnswer).not.toHaveBeenCalled();
    expect(gameService.giveUp).not.toHaveBeenCalled();
  });

  it('scores a correct guess, ticks it and announces the win', async () => {
    const { commands, gameService, collector } = build();
    gameService.checkAnswer.mockReturnValue({ isCorrect: true, session: session(), timeSeconds: 9 } as never);

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    const msg = mkMsg({ content: 'Radiohead' });
    await collector!.emit(msg);

    expect(gameService.checkAnswer).toHaveBeenCalledWith('C1', '222', 'Bob', 'Radiohead');
    expect(collector!.stop).toHaveBeenCalledWith('won');
    expect(msg.react).toHaveBeenCalledWith('✅');
    expect(GameBuilders.buildGameWonResponse).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1' }),
      9,
      stats(),
      0x112233,
    );
  });

  it('falls back to the username when the guesser has no guild nickname', async () => {
    const { commands, gameService, collector } = build();
    gameService.checkAnswer.mockReturnValue({ isCorrect: true, session: session(), timeSeconds: 3 } as never);

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    await collector!.emit(mkMsg({ content: 'Radiohead', member: null }));

    expect(gameService.checkAnswer.mock.calls[0]![2]).toBe('bob');
  });

  it('stays silent on a wrong guess — no card, no tick, no stop', async () => {
    const { commands, gameService, collector } = build();

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    await collector!.emit(mkMsg({ content: 'Blur' }));

    expect(gameService.checkAnswer).toHaveBeenCalledTimes(1);
    expect(collector!.stop).not.toHaveBeenCalled();
    expect(GameBuilders.buildGameWonResponse).not.toHaveBeenCalled();
  });

  it('defaults the elapsed time to 0 when the service reports none', async () => {
    // `collector!` — `build()` types it as possibly null because a caller MAY
    // override it with null, but this test passes no override so it is always
    // a real collector. Under noUncheckedIndexedAccess-adjacent strictness the
    // bare name is a compile error the suite never reports.
    const { commands, gameService, collector } = build();
    gameService.checkAnswer.mockReturnValue({ isCorrect: true, session: session() } as never);

    await commands.jumbleAsync(ctx({ channel: mkChannel(collector!) }), '');
    await collector!.emit(mkMsg());

    expect(vi.mocked(GameBuilders.buildGameWonResponse).mock.calls[0]![1]).toBe(0);
  });
});

describe('GameCommands — the expiry hook degrades quietly but never lies', () => {
  it('posts the time-up card to the game channel', async () => {
    const { commands, gameService } = build();
    const channel = mkChannel(null);

    await commands.jumbleAsync(ctx({ channel }), '');
    const onExpire = (gameService.startGame.mock.calls[0]![0] as { onExpire: (s: unknown) => Promise<void> })
      .onExpire;
    await onExpire(session());

    expect(GameBuilders.buildGameExpiredResponse).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed expiry send instead of crashing the timer', async () => {
    // The session is already ended and deregistered by the timer that calls
    // this, so a send failure is an absence, not a false claim.
    const { commands, gameService } = build();
    const channel = mkChannel(null);
    channel.send.mockRejectedValueOnce(new Error('Missing Permissions'));

    await commands.jumbleAsync(ctx({ channel }), '');
    const onExpire = (gameService.startGame.mock.calls[0]![0] as { onExpire: (s: unknown) => Promise<void> })
      .onExpire;

    await expect(onExpire(session())).resolves.toBeUndefined();
  });

  it('does nothing when the channel has gone away by expiry time', async () => {
    const { commands, gameService } = build();

    await commands.jumbleAsync(ctx({ channel: null }), '');
    const onExpire = (gameService.startGame.mock.calls[0]![0] as { onExpire: (s: unknown) => Promise<void> })
      .onExpire;

    await expect(onExpire(session())).resolves.toBeUndefined();
    expect(GameBuilders.buildGameExpiredResponse).not.toHaveBeenCalled();
  });
});

describe('GameCommands — optional collaborators are genuinely optional', () => {
  it('runs without a colour service, falling back to a null accent', async () => {
    const { lastfmRepository, gameService } = build();
    const bare = new GameCommands(
      { getUserByDiscordId: vi.fn(async () => REGISTERED) } as never,
      lastfmRepository as never,
      gameService as never,
    );

    const result = await bare.jumbleAsync(ctx(), '');

    expect(result).toEqual({ marker: 'jumble' });
    expect(vi.mocked(GameBuilders.buildJumbleStartResponse).mock.calls[0]![1]).toBeNull();
  });

  it('runs pixelation without an artwork service, keeping the Last.fm cover', async () => {
    const { lastfmRepository, gameService } = build();
    const bare = new GameCommands(
      { getUserByDiscordId: vi.fn(async () => REGISTERED) } as never,
      lastfmRepository as never,
      gameService as never,
      undefined,
    );

    await bare.pixelAsync(ctx(), '');

    expect(gameService.pixelateCover).toHaveBeenCalledWith('https://img/real.jpg', 0.04);
  });
});
