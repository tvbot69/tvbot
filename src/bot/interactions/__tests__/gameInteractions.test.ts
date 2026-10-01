import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { GameInteractions } from '../gameInteractions';
import { GameBuilders } from '@bot/builders/gameBuilders';
import type { JumbleSession } from '@bot/services/gameService';
import type { ButtonInteraction } from 'discord.js';

const makeSession = (over: Partial<JumbleSession> = {}): JumbleSession => ({
  sessionId: 's1',
  channelId: 'c1',
  guildId: 'g1',
  starterUserId: 'lastfm1',
  starterDiscordId: 'caller1',
  type: 'artist',
  correctAnswer: 'Radiohead',
  displayTarget: 'RDOHIAEA',
  artistName: 'Radiohead',
  dateStarted: new Date('2026-01-01'),
  hints: ['R _ _ _ _ _ _ _ _'],
  hintsShown: 0,
  blurLevel: 0.04,
  reshuffles: 0,
  ended: false,
  ...over,
});

const pixelBuffer = Buffer.from('fake-pixel-png');

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'caller1' },
    deferred: false,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const gameService = {
    getActiveGameById: vi.fn(() => makeSession()),
    reshuffle: vi.fn(() => 'XOARIHDEA'),
    nextHint: vi.fn(() => ({ hint: 'Extra Hint' })),
    giveUp: vi.fn(() => makeSession({ ended: true, dateEnded: new Date('2026-01-02') })),
    pixelateCover: vi.fn(async () => pixelBuffer),
    ...(over.gameService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const gi = new GameInteractions(gameService as never, colorService as never);
  return { gi, gameService, colorService };
};

/** Sentinel response. `componentsV2Container` is the gate the handler checks. */
const sentinel = (label: string) => ({ componentsV2Container: { label } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(GameBuilders, 'buildGameGiveUpResponse').mockReturnValue(sentinel('giveup') as never);
  vi.spyOn(GameBuilders, 'buildJumbleStartResponse').mockReturnValue(sentinel('jumble') as never);
  vi.spyOn(GameBuilders, 'buildPixelStartResponse').mockReturnValue(sentinel('pixel') as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameInteractions.handleButton — session guard', () => {
  it('ignores a customId that does not start with "game:"', async () => {
    const { gi, gameService } = build();
    const press = mkButton('genre:page:next:top:x:0:caller1');

    await gi.handleButton(press);

    expect(gameService.getActiveGameById).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('replies "already ended" when the session id is unknown', async () => {
    const { gi, colorService } = build({
      gameService: { getActiveGameById: vi.fn(() => undefined) },
    });
    const press = mkButton('game:hint:missing');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This game session has already ended.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
    // The session guard runs before the accent lookup, so no colour work happens.
    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
  });

  it('replies "already ended" for an already-ended session', async () => {
    const { gi } = build({
      gameService: { getActiveGameById: vi.fn(() => makeSession({ ended: true })) },
    });
    const press = mkButton('game:reshuffle:s1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This game session has already ended.',
      flags: MessageFlags.Ephemeral,
    });
    expect(GameBuilders.buildJumbleStartResponse).not.toHaveBeenCalled();
  });

  it('looks the session up by the id in the customId', async () => {
    const { gi, gameService } = build();

    await gi.handleButton(mkButton('game:hint:abc123'));

    expect(gameService.getActiveGameById).toHaveBeenCalledWith('abc123');
  });
});

describe('GameInteractions.handleButton — accent colour resolution', () => {
  it('resolves the accent colour for a guild interaction', async () => {
    const { gi, colorService } = build();

    await gi.handleButton(mkButton('game:hint:s1'));

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('g1');
    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledWith(expect.anything(), 0xff0000);
  });

  it('passes a null accent and skips the lookup in a DM', async () => {
    const { gi, colorService } = build();
    const press = mkButton('game:hint:s1', { guildId: null });

    await gi.handleButton(press);

    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledWith(expect.anything(), null);
  });

  it('tolerates a missing ColorService entirely', async () => {
    const gameService = {
      getActiveGameById: vi.fn(() => makeSession()),
      nextHint: vi.fn(() => ({ hint: 'Extra Hint' })),
    };
    const gi = new GameInteractions(gameService as never);
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledWith(expect.anything(), null);
    expect(press.update).toHaveBeenCalledTimes(1);
  });
});

describe('GameInteractions.handleButton — giveup', () => {
  it('ends the session and builds the give-up response', async () => {
    const ended = makeSession({ ended: true, dateEnded: new Date('2026-01-02') });
    const { gi, gameService } = build({ gameService: { giveUp: vi.fn(() => ended) } });
    const press = mkButton('game:giveup:s1');

    await gi.handleButton(press);

    expect(gameService.giveUp).toHaveBeenCalledWith('s1');
    expect(GameBuilders.buildGameGiveUpResponse).toHaveBeenCalledWith(ended, 0xff0000);
    expect(press.update).toHaveBeenCalledWith({
      components: [{ label: 'giveup' }],
      flags: MessageFlags.IsComponentsV2,
      files: [],
    });
  });

  it('replies "already completed" when giveUp returns nothing', async () => {
    const { gi } = build({ gameService: { giveUp: vi.fn(() => undefined) } });
    const press = mkButton('game:giveup:s1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Game already completed.',
      flags: MessageFlags.Ephemeral,
    });
    expect(GameBuilders.buildGameGiveUpResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('does not update when the builder returns no components container', async () => {
    vi.spyOn(GameBuilders, 'buildGameGiveUpResponse').mockReturnValue({} as never);
    const { gi } = build();
    const press = mkButton('game:giveup:s1');

    await gi.handleButton(press);

    expect(GameBuilders.buildGameGiveUpResponse).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('GameInteractions.handleButton — reshuffle', () => {
  it('reshuffles and rebuilds the jumble response from the session', async () => {
    const { gi, gameService } = build();
    const session = makeSession();
    gameService.getActiveGameById.mockReturnValue(session);
    const press = mkButton('game:reshuffle:s1');

    await gi.handleButton(press);

    expect(gameService.reshuffle).toHaveBeenCalledWith('s1');
    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledWith(session, 0xff0000);
    expect(press.update).toHaveBeenCalledWith({
      components: [{ label: 'jumble' }],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  it('replies "cannot reshuffle" when the service refuses', async () => {
    const { gi } = build({ gameService: { reshuffle: vi.fn(() => undefined) } });
    const press = mkButton('game:reshuffle:s1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Cannot reshuffle this game.',
      flags: MessageFlags.Ephemeral,
    });
    expect(GameBuilders.buildJumbleStartResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('does not update when the builder returns no components container', async () => {
    vi.spyOn(GameBuilders, 'buildJumbleStartResponse').mockReturnValue({} as never);
    const { gi } = build();
    const press = mkButton('game:reshuffle:s1');

    await gi.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('GameInteractions.handleButton — hint on an artist jumble', () => {
  it('takes a hint and updates the card', async () => {
    const { gi, gameService } = build();
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(gameService.nextHint).toHaveBeenCalledWith('s1');
    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledWith(
      makeSession(),
      0xff0000,
    );
    expect(press.update).toHaveBeenCalledWith({
      components: [{ label: 'jumble' }],
      flags: MessageFlags.IsComponentsV2,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies when there are no hints left', async () => {
    const { gi } = build({ gameService: { nextHint: vi.fn(() => undefined) } });
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'No more hints available for this game!',
      flags: MessageFlags.Ephemeral,
    });
    expect(GameBuilders.buildJumbleStartResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('does not update when the builder returns no components container', async () => {
    vi.spyOn(GameBuilders, 'buildJumbleStartResponse').mockReturnValue({} as never);
    const { gi } = build();
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('GameInteractions.handleButton — hint on a pixel game', () => {
  const pixelSession = (over: Partial<JumbleSession> = {}) =>
    makeSession({
      type: 'pixel',
      correctAnswer: 'OK Computer',
      displayTarget: '',
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      coverUrl: 'https://example.test/cover.jpg',
      blurLevel: 0.08,
      ...over,
    });

  it('defers, repixelates the cover at the session blur level and edits the reply', async () => {
    const session = pixelSession();
    const { gi, gameService } = build({ gameService: { getActiveGameById: vi.fn(() => session) } });
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(gameService.pixelateCover).toHaveBeenCalledWith('https://example.test/cover.jpg', 0.08);
    expect(GameBuilders.buildPixelStartResponse).toHaveBeenCalledWith(session, pixelBuffer, 0xff0000);
    expect(press.editReply).toHaveBeenCalledWith({
      files: [{ attachment: pixelBuffer, name: 'pixel-cover.png' }],
      components: [{ label: 'pixel' }],
      flags: MessageFlags.IsComponentsV2,
    });
    expect(GameBuilders.buildJumbleStartResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('uses the session blurLevel, not the one nextHint reports back', async () => {
    const session = pixelSession({ blurLevel: 0.04 });
    const { gi, gameService } = build({
      gameService: {
        getActiveGameById: vi.fn(() => session),
        nextHint: vi.fn(() => ({ blurLevel: 0.12 })),
      },
    });

    await gi.handleButton(mkButton('game:hint:s1'));

    // nextHint already bumped the session to 0.12 in the real service; the
    // handler passes the (pre-bump, in a double) field straight through.
    expect(gameService.pixelateCover).toHaveBeenCalledWith('https://example.test/cover.jpg', 0.04);
  });

  it('falls back to the jumble builder when a pixel game has no coverUrl', async () => {
    const session = pixelSession({ coverUrl: undefined });
    const { gi, gameService } = build({ gameService: { getActiveGameById: vi.fn(() => session) } });
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(gameService.pixelateCover).not.toHaveBeenCalled();
    expect(GameBuilders.buildPixelStartResponse).not.toHaveBeenCalled();
    expect(GameBuilders.buildJumbleStartResponse).toHaveBeenCalledWith(session, 0xff0000);
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('replies when nextHint refuses, without pixelating', async () => {
    const session = pixelSession();
    const { gi, gameService } = build({
      gameService: {
        getActiveGameById: vi.fn(() => session),
        nextHint: vi.fn(() => undefined),
      },
    });
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'No more hints available for this game!',
      flags: MessageFlags.Ephemeral,
    });
    expect(gameService.pixelateCover).not.toHaveBeenCalled();
  });

  it('does not edit when the pixel builder returns no components container', async () => {
    vi.spyOn(GameBuilders, 'buildPixelStartResponse').mockReturnValue({} as never);
    const session = pixelSession();
    const { gi } = build({ gameService: { getActiveGameById: vi.fn(() => session) } });
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    // It still defers and pixelates; only the edit is skipped.
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('still proceeds when deferUpdate throws an already-acknowledged error', async () => {
    const session = pixelSession();
    const { gi, gameService } = build({ gameService: { getActiveGameById: vi.fn(() => session) } });
    const press = mkButton('game:hint:s1', {
      deferUpdate: vi.fn(async () => {
        throw Object.assign(new Error('InteractionAlreadyAcknowledged'), { code: 40060 });
      }),
    });

    await gi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(gameService.pixelateCover).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });
});

describe('GameInteractions.handleButton — unknown action', () => {
  it('validates the session and resolves the colour, then does nothing', async () => {
    const { gi, gameService, colorService } = build();
    const press = mkButton('game:teleport:s1');

    await gi.handleButton(press);

    expect(gameService.getActiveGameById).toHaveBeenCalledWith('s1');
    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('g1');
    expect(GameBuilders.buildGameGiveUpResponse).not.toHaveBeenCalled();
    expect(GameBuilders.buildJumbleStartResponse).not.toHaveBeenCalled();
    expect(GameBuilders.buildPixelStartResponse).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('GameInteractions.handleButton — real builders', () => {
  it('updates with a real Components V2 give-up container', async () => {
    vi.restoreAllMocks();
    const { gi } = build();
    const press = mkButton('game:giveup:s1');

    await gi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    const payload = press.update.mock.calls[0]![0] as { flags: number; components: unknown[]; files: unknown[] };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toHaveLength(1);
    expect(payload.files).toEqual([]);
  });

  it('updates with a real Components V2 jumble container', async () => {
    vi.restoreAllMocks();
    const { gi } = build();
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    const payload = press.update.mock.calls[0]![0] as { flags: number; components: unknown[] };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toHaveLength(1);
  });

  it('edits with a real Components V2 pixel container and the png', async () => {
    vi.restoreAllMocks();
    const session = makeSession({
      type: 'pixel',
      correctAnswer: 'OK Computer',
      displayTarget: '',
      albumName: 'OK Computer',
      coverUrl: 'https://example.test/cover.jpg',
    });
    const { gi } = build({ gameService: { getActiveGameById: vi.fn(() => session) } });
    const press = mkButton('game:hint:s1');

    await gi.handleButton(press);

    expect(press.editReply).toHaveBeenCalledTimes(1);
    const payload = press.editReply.mock.calls[0]![0] as {
      flags: number;
      files: { name: string; attachment: Buffer }[];
      components: unknown[];
    };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.files[0]!.name).toBe('pixel-cover.png');
    expect(payload.files[0]!.attachment).toEqual(pixelBuffer);
    expect(payload.components).toHaveLength(1);
  });
});
