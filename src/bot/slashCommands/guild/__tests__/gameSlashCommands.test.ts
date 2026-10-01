import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GameSlashCommands } from '@bot/slashCommands/guild/gameSlashCommands';
import { GameBuilders } from '@bot/builders/guild/gameBuilders';
import { GameService } from '@bot/services/guild/gameService';
import { isPlaceholderImageUrl } from '@bot/services/media/artworkService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { JumbleSession, UserGameStats } from '@bot/services/guild/gameService';

/**
 * `/game` — the slash twin of `gameCommands.ts`.
 *
 * The differences from the text half are all in how options arrive, and they are
 * exactly where a twin drifts: the stats flag is a real Discord BOOLEAN option
 * here (so an absent option must mean `false`, not `undefined` passed into an
 * `includes()`), and `/game stats` takes a USER OPTION that can name somebody
 * other than the caller. That user option is the one path that reads another
 * person's stats, so it is asserted in both directions — named target, and no
 * target falling back to the caller.
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

/** Options double: only the three accessors the command actually calls. */
const options = (o: { sub?: string; stats?: boolean; user?: { id: string; displayName: string } | null }) => ({
  getSubcommand: vi.fn((..._a: unknown[]) => o.sub ?? 'jumble'),
  getBoolean: vi.fn((..._a: unknown[]) => o.stats ?? false),
  getUser: vi.fn((..._a: unknown[]) => o.user ?? null),
});

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { id: '222', name: 'Test Guild' },
    channelId: 'C1',
    prefix: '.',
    discordDisplayName: 'Caller',
    interaction: { options: options({}) },
    ...over,
  }) as unknown as ContextModel;

const dmCtx = () => ctx({ guildId: undefined, guild: null });

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

  const userService = { getUserByDiscordId: vi.fn(async (..._a: unknown[]) => caller) };
  const lastfmRepository = {
    getTopArtists: vi.fn(async (..._a: unknown[]) =>
      over.topArtists === undefined ? ([{ name: 'Radiohead', playcount: 900 }] as unknown[]) : over.topArtists,
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

  const commands = new GameSlashCommands(
    userService as never,
    lastfmRepository as never,
    gameService as never,
    colorService as never,
    artworkService as never,
  );

  return { commands, userService, lastfmRepository, gameService, colorService, artworkService, collector };
};

/**
 * Drive the module through its registered slash entry point, as Discord does.
 * `executeAsync` takes ONE argument — the context — so the historical second
 * argument is gone; passing one is a compile error and `npm test` never saw it.
 */
const invoke = (commands: GameSlashCommands, context: ContextModel) => commands.commands[0]!.executeAsync(context);

const withSub = (context: ContextModel, o: Parameters<typeof options>[0]): ContextModel =>
  ctx({ ...(context as unknown as Record<string, unknown>), interaction: { options: options(o) } });

const mkMsg = (over: Record<string, unknown> = {}) => ({
  content: 'Radiohead',
  author: { id: '222', username: 'bob', bot: false },
  member: { displayName: 'Bob' },
  channel: { send: vi.fn(async (..._a: unknown[]) => undefined) },
  react: vi.fn(async (..._a: unknown[]) => undefined),
  ...over,
});

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

describe('GameSlashCommands — the /game definition', () => {
  it('registers one command with the three documented subcommands', () => {
    const { commands } = build();
    const data = commands.commands[0]!.data.toJSON();
    expect(data.name).toBe('game');
    expect((data.options ?? []).map(o => o.name)).toEqual(['jumble', 'pixel', 'stats']);
  });

  it('makes the stats flags optional and the stats user optional', () => {
    const { commands } = build();
    const data = commands.commands[0]!.data.toJSON();
    for (const sub of data.options ?? []) {
      // `toJSON()` widens each entry to a UNION of every discord.js option
      // shape, and only the subcommand variant carries `.options`. Narrowing on
      // `'options' in sub` is the type guard; without it `sub.options` is a
      // compile error on three of the four members of the union.
      if (!('options' in sub)) continue;
      for (const opt of sub.options ?? []) {
        expect(opt.required ?? false).toBe(false);
      }
    }
  });
});

describe('GameSlashCommands — subcommand routing', () => {
  it.each(['jumble', 'pixel', 'stats'])('routes /game %s to its own handler', async (sub) => {
    const { commands, lastfmRepository, gameService } = build();

    await invoke(commands, withSub(ctx(), { sub }));

    if (sub === 'stats') {
      // The stats subcommand must never read Last.fm or open a game.
      expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
      expect(gameService.startGame).not.toHaveBeenCalled();
    } else {
      expect(gameService.startGame).toHaveBeenCalledTimes(1);
    }
  });

  it('falls back to jumble for an unrecognised subcommand rather than erroring', () => {
    const { commands } = build();
    const subcommands = commands.commands[0]!.data.toJSON().options ?? [];
    // The default arm exists so a future subcommand added to Discord but not
    // yet handled still does something coherent.
    expect(subcommands.map(o => o.name)).not.toContain('');
  });
});

describe('GameSlashCommands — /game stats reads the named user', () => {
  it('reads the target user option when one is given', async () => {
    const { commands, gameService } = build();

    await invoke(commands, withSub(ctx(), { sub: 'stats', user: { id: '999', displayName: 'Beta' } }));

    expect(gameService.getUserStats).toHaveBeenCalledWith('999');
    expect(vi.mocked(GameBuilders.buildGameStatsResponse).mock.calls[0]![0]).toBe('Beta');
  });

  it('falls back to the caller when no user option is supplied', async () => {
    const { commands, gameService } = build();

    await invoke(commands, withSub(ctx(), { sub: 'stats', user: null }));

    expect(gameService.getUserStats).toHaveBeenCalledWith('111');
  });

  it('does not require a linked Last.fm account to read stats', async () => {
    // Stats are keyed on the Discord id and live in memory, so gating this on a
    // Last.fm link would hide a real record behind an unrelated precondition.
    const { commands } = build({ caller: null });

    const result = await invoke(commands, withSub(ctx(), { sub: 'stats' }));

    expect(result).toEqual({ marker: 'stats' });
  });
});

describe('GameSlashCommands — /game jumble guards', () => {
  it('refuses in a DM', async () => {
    const { commands, lastfmRepository, gameService } = build();

    const result = await invoke(commands, withSub(dmCtx(), { sub: 'jumble' }));

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller and points at the slash register form', async () => {
    const { commands, gameService } = build({ caller: null });

    const result = await invoke(commands, withSub(ctx(), { sub: 'jumble' }));

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect((result.embed.data.description ?? '') as string).toContain('/register');
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('refuses a second live game in the same channel', async () => {
    const { commands } = build({ active: session({ ended: false }) });

    const result = await invoke(commands, withSub(ctx(), { sub: 'jumble' }));

    expect(result.commandResponse).toBe(CommandResponse.Cooldown);
    expect(GameBuilders.buildJumbleStartResponse).not.toHaveBeenCalled();
  });

  it('reports an empty library rather than inventing a puzzle', async () => {
    const { commands, gameService } = build({ topArtists: [] });

    const result = await invoke(commands, withSub(ctx(), { sub: 'jumble' }));

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('reports when no artist name survives the length and prefix filters', async () => {
    const { commands } = build({ topArtists: [{ name: 'AB', playcount: 1 }] });

    const result = await invoke(commands, withSub(ctx(), { sub: 'jumble' }));

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect((result.embed.data.description ?? '') as string).toContain('suitable artists');
  });

  it('starts the jumble session for the chosen artist', async () => {
    const { commands, lastfmRepository, gameService } = build();

    const result = await invoke(commands, withSub(ctx(), { sub: 'jumble' }));

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('Alpha', undefined, 250);
    expect(gameService.startGame.mock.calls[0]![0]).toMatchObject({
      type: 'artist',
      correctAnswer: 'Radiohead',
      artistName: 'Radiohead',
      channelId: 'C1',
    });
    expect(result).toEqual({ marker: 'jumble' });
  });

  it('registers the collector when the channel supports one', async () => {
    const { commands, gameService, collector } = build();

    await invoke(
      commands,
      withSub(ctx({ channel: { createMessageCollector: vi.fn(() => collector), send: vi.fn() } }), { sub: 'jumble' }),
    );

    expect(gameService.setCollector).toHaveBeenCalledWith('sess1', collector);
  });

  it('answers with stats when the stats option is true, without starting a game', async () => {
    const { commands, lastfmRepository, gameService } = build();

    const result = await invoke(commands, withSub(ctx(), { sub: 'jumble', stats: true }));

    expect(result).toEqual({ marker: 'stats' });
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(gameService.startGame).not.toHaveBeenCalled();
  });

  it('treats an absent stats option as false', async () => {
    const { commands, gameService } = build();

    await invoke(commands, withSub(ctx(), { sub: 'jumble', stats: false }));

    expect(gameService.startGame).toHaveBeenCalledTimes(1);
  });
});

describe('GameSlashCommands — /game pixel guards and artwork', () => {
  it('refuses in a DM', async () => {
    const { commands, gameService } = build();

    const result = await invoke(commands, withSub(dmCtx(), { sub: 'pixel' }));

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(gameService.pixelateCover).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller', async () => {
    const { commands } = build({ caller: null });

    const result = await invoke(commands, withSub(ctx(), { sub: 'pixel' }));

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('refuses a second live game', async () => {
    const { commands } = build({ active: session({ ended: false }) });

    const result = await invoke(commands, withSub(ctx(), { sub: 'pixel' }));

    expect(result.commandResponse).toBe(CommandResponse.Cooldown);
  });

  it('refuses when no album has usable cover art', async () => {
    const { commands, gameService } = build({
      topAlbums: [
        { name: 'Bare', artistName: 'X', imageUrl: undefined },
        {
          name: 'Placeholder',
          artistName: 'X',
          imageUrl: 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
        },
      ],
    });

    const result = await invoke(commands, withSub(ctx(), { sub: 'pixel' }));

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(gameService.pixelateCover).not.toHaveBeenCalled();
  });

  it('rejects a cascade placeholder and keeps the Last.fm cover', async () => {
    const { commands, artworkService, gameService } = build({
      albumCover: 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
    });

    await invoke(commands, withSub(ctx(), { sub: 'pixel' }));

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('OK Computer', 'Radiohead');
    const used = gameService.pixelateCover.mock.calls[0]![0] as string;
    expect(isPlaceholderImageUrl(used)).toBe(false);
    expect(used).toBe('https://img/real.jpg');
  });

  it('prefers a real cascade cover', async () => {
    const { commands, gameService } = build();

    await invoke(commands, withSub(ctx(), { sub: 'pixel' }));

    expect(gameService.pixelateCover).toHaveBeenCalledWith('https://img/cascade.jpg', 0.04);
    expect(GameBuilders.buildPixelStartResponse).toHaveBeenCalledTimes(1);
  });

  it('starts a pixel session carrying album, artist and cover', async () => {
    const { commands, gameService } = build();

    await invoke(commands, withSub(ctx(), { sub: 'pixel' }));

    expect(gameService.startGame.mock.calls[0]![0]).toMatchObject({
      type: 'pixel',
      correctAnswer: 'OK Computer',
      albumName: 'OK Computer',
      artistName: 'Radiohead',
      coverUrl: 'https://img/cascade.jpg',
    });
  });

  it('answers with stats when the stats option is true', async () => {
    const { commands, gameService } = build();

    const result = await invoke(commands, withSub(ctx(), { sub: 'pixel', stats: true }));

    expect(result).toEqual({ marker: 'stats' });
    expect(gameService.startGame).not.toHaveBeenCalled();
  });
});

describe('GameSlashCommands — the collector resolves a game', () => {
  it('stops and announces on a correct guess', async () => {
    const { commands, gameService, collector } = build();
    gameService.checkAnswer.mockReturnValue({ isCorrect: true, session: session(), timeSeconds: 11 } as never);

    await invoke(commands, withSub(ctx({ channel: { createMessageCollector: vi.fn(() => collector), send: vi.fn() } }), { sub: 'jumble' }));
    const msg = mkMsg();
    await collector!.emit(msg);

    expect(gameService.checkAnswer).toHaveBeenCalledWith('C1', '222', 'Bob', 'Radiohead');
    expect(collector!.stop).toHaveBeenCalledWith('won');
    expect(msg.react).toHaveBeenCalledWith('✅');
    expect(GameBuilders.buildGameWonResponse).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1' }),
      11,
      stats(),
      0x112233,
    );
  });

  it('ends the game on a give up without announcing a win', async () => {
    const { commands, gameService, collector } = build();

    await invoke(commands, withSub(ctx({ channel: { createMessageCollector: vi.fn(() => collector), send: vi.fn() } }), { sub: 'jumble' }));
    await collector!.emit(mkMsg({ content: 'quit' }));

    expect(gameService.giveUp).toHaveBeenCalledWith('sess1');
    expect(GameBuilders.buildGameGiveUpResponse).toHaveBeenCalledTimes(1);
    expect(GameBuilders.buildGameWonResponse).not.toHaveBeenCalled();
  });

  it('stays silent on a wrong guess', async () => {
    const { commands, collector } = build();

    await invoke(commands, withSub(ctx({ channel: { createMessageCollector: vi.fn(() => collector), send: vi.fn() } }), { sub: 'jumble' }));
    await collector!.emit(mkMsg({ content: 'Blur' }));

    expect(collector!.stop).not.toHaveBeenCalled();
    expect(GameBuilders.buildGameWonResponse).not.toHaveBeenCalled();
  });

  it('uses the username when the winner has no guild nickname', async () => {
    const { commands, gameService, collector } = build();
    gameService.checkAnswer.mockReturnValue({ isCorrect: true, session: session(), timeSeconds: 4 } as never);

    await invoke(commands, withSub(ctx({ channel: { createMessageCollector: vi.fn(() => collector), send: vi.fn() } }), { sub: 'jumble' }));
    await collector!.emit(mkMsg({ member: null }));

    expect(gameService.checkAnswer.mock.calls[0]![2]).toBe('bob');
  });
});

describe('GameSlashCommands — the expiry hook and optional collaborators', () => {
  it('posts the time-up card to the game channel', async () => {
    const { commands, gameService } = build();
    const channel = { send: vi.fn(async (..._a: unknown[]) => undefined) };

    await invoke(commands, withSub(ctx({ channel }), { sub: 'jumble' }));
    const onExpire = (gameService.startGame.mock.calls[0]![0] as { onExpire: (s: unknown) => Promise<void> }).onExpire;
    await onExpire(session());

    expect(GameBuilders.buildGameExpiredResponse).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed expiry send rather than crashing the timer', async () => {
    const { commands, gameService } = build();
    const channel = { send: vi.fn(async (..._a: unknown[]) => undefined) };
    channel.send.mockRejectedValueOnce(new Error('Missing Access'));

    await invoke(commands, withSub(ctx({ channel }), { sub: 'jumble' }));
    const onExpire = (gameService.startGame.mock.calls[0]![0] as { onExpire: (s: unknown) => Promise<void> }).onExpire;

    await expect(onExpire(session())).resolves.toBeUndefined();
  });

  it('runs without a colour service and falls back to a null accent', async () => {
    const { lastfmRepository, gameService } = build();
    const bare = new GameSlashCommands(
      { getUserByDiscordId: vi.fn(async () => REGISTERED) } as never,
      lastfmRepository as never,
      gameService as never,
    );

    const result = await invoke(bare, withSub(ctx(), { sub: 'jumble' }));

    expect(result).toEqual({ marker: 'jumble' });
    expect(vi.mocked(GameBuilders.buildJumbleStartResponse).mock.calls[0]![1]).toBeNull();
  });

  it('runs pixelation without an artwork service, keeping the Last.fm cover', async () => {
    const { lastfmRepository, gameService } = build();
    const bare = new GameSlashCommands(
      { getUserByDiscordId: vi.fn(async () => REGISTERED) } as never,
      lastfmRepository as never,
      gameService as never,
      undefined,
    );

    await invoke(bare, withSub(ctx(), { sub: 'pixel' }));

    expect(gameService.pixelateCover).toHaveBeenCalledWith('https://img/real.jpg', 0.04);
  });

  it('uses the jumble time limit and the pixel limit respectively', async () => {
    const { commands } = build();
    const jumbleChannel = { createMessageCollector: vi.fn((..._a: unknown[]) => mkCollector()), send: vi.fn() };
    await invoke(commands, withSub(ctx({ channel: jumbleChannel }), { sub: 'jumble' }));
    expect(jumbleChannel.createMessageCollector.mock.calls[0]![0]).toMatchObject({
      time: GameService.JumbleSecondsToGuess * 1000,
    });

    const pixelChannel = { createMessageCollector: vi.fn((..._a: unknown[]) => mkCollector()), send: vi.fn() };
    await invoke(commands, withSub(ctx({ channel: pixelChannel }), { sub: 'pixel' }));
    expect(pixelChannel.createMessageCollector.mock.calls[0]![0]).toMatchObject({
      time: GameService.PixelationSecondsToGuess * 1000,
    });
  });
});
