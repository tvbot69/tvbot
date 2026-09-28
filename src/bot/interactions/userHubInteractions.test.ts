import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserHubInteractions } from './userHubInteractions';
import { UserHubBuilders } from '@bot/builders/userHubBuilders';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { JudgeResult } from '@bot/services/aiJudgeService';
import type { ButtonInteraction } from 'discord.js';

const makeJudgeResult = (over: Partial<JudgeResult> = {}): JudgeResult => ({
  mode: 'judge',
  userNameLastFm: 'user1',
  discordUserId: 'target1',
  rating: '8.5',
  headline: 'Solid taste',
  critique: 'You like the good stuff.',
  topArtists: ['Radiohead'],
  topTracks: ['Karma Police'],
  period: TimePeriod.Quarterly,
  ...over,
});

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1', displayName: 'Caller' },
    guild: { members: { cache: new Map<string, { displayName: string }>() } },
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const aiJudgeService = {
    evaluateTaste: vi.fn(async () => makeJudgeResult()),
    ...(over.aiJudgeService as object),
  };
  const botScrobblingService = {
    toggleUserOptIn: vi.fn(() => true),
    getNowPlaying: vi.fn(() => ({ trackName: 'Song' })),
    ...(over.botScrobblingService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'user1' })),
    ...(over.userService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const injected = 'colorService' in over ? (over.colorService as object | undefined) : colorService;
  const uhi = new UserHubInteractions(
    aiJudgeService as never,
    botScrobblingService as never,
    userService as never,
    injected as never,
  );
  return { uhi, aiJudgeService, botScrobblingService, userService, colorService };
};

const judgeArg = () =>
  (UserHubBuilders.buildJudgeResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    result: JudgeResult;
    displayName: string;
    accentColor: number | null;
  };

const scrobbleArg = () =>
  (UserHubBuilders.buildBotScrobblingResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    optedIn: boolean;
    nowPlaying: unknown;
    accentColor: number | null;
  };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(UserHubBuilders, 'buildJudgeResponse').mockReturnValue({ componentsV2Container: {} } as never);
  vi.spyOn(UserHubBuilders, 'buildBotScrobblingResponse').mockReturnValue({ componentsV2Container: {} } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserHubInteractions.handleButton — guard clauses', () => {
  it('does nothing for a customId without the userhub prefix', async () => {
    const { uhi, userService, colorService } = build();
    const press = mkButton('topartists:next:0:user1:weekly');

    await uhi.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('resolves no accent colour when the color service was not injected', async () => {
    const { uhi } = build({ colorService: undefined });
    const press = mkButton('userhub:botscrobble:enable');

    await uhi.handleButton(press);

    expect(scrobbleArg().accentColor).toBeNull();
  });

  it('resolves no accent colour when the interaction has no guild', async () => {
    const { uhi, colorService } = build();
    const press = mkButton('userhub:botscrobble:enable', { guildId: null });

    await uhi.handleButton(press);

    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
    expect(scrobbleArg().accentColor).toBeNull();
  });

  it('passes the resolved accent colour to both builders', async () => {
    const { uhi, colorService } = build({ colorService: { getAccentColorAsync: vi.fn(async () => 0x0abcde) } });

    await uhi.handleButton(mkButton('userhub:judge:judge:target1'));
    expect(judgeArg().accentColor).toBe(0x0abcde);

    await uhi.handleButton(mkButton('userhub:botscrobble:enable'));
    expect(scrobbleArg().accentColor).toBe(0x0abcde);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('g1');
  });
});

describe('UserHubInteractions.handleButton — userhub:judge', () => {
  it('looks the target user up by the id in the customId', async () => {
    const { uhi, userService } = build();
    await uhi.handleButton(mkButton('userhub:judge:judge:target1'));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('target1');
  });

  it('falls back to the pressing user when no target id is present', async () => {
    const { uhi, userService } = build();
    await uhi.handleButton(mkButton('userhub:judge:judge'));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
  });

  it('replies ephemerally when the lastfm user is not found', async () => {
    const { uhi, aiJudgeService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton('userhub:judge:judge:target1');

    await uhi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Last.fm user details could not be found.',
      ephemeral: true,
    });
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(aiJudgeService.evaluateTaste).not.toHaveBeenCalled();
    expect(UserHubBuilders.buildJudgeResponse).not.toHaveBeenCalled();
  });

  it('defers the update once the user resolves', async () => {
    const { uhi } = build();
    const press = mkButton('userhub:judge:judge:target1');

    await uhi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure of the deferUpdate', async () => {
    const { uhi, aiJudgeService } = build();
    const press = mkButton('userhub:judge:judge:target1', {
      deferUpdate: vi.fn(async () => {
        throw new Error('Unknown Interaction');
      }),
    });

    await uhi.handleButton(press);

    expect(aiJudgeService.evaluateTaste).toHaveBeenCalledTimes(1);
  });

  it('evaluates the taste for the quarterly period with the lastfm username', async () => {
    const { uhi, aiJudgeService } = build();
    await uhi.handleButton(mkButton('userhub:judge:judge:target1'));

    expect(aiJudgeService.evaluateTaste).toHaveBeenCalledWith({
      userNameLastFm: 'user1',
      discordUserId: 'target1',
      mode: 'judge',
      period: TimePeriod.Quarterly,
    });
  });

  it('forwards the roast mode', async () => {
    const { uhi, aiJudgeService } = build();
    await uhi.handleButton(mkButton('userhub:judge:roast:target1'));

    expect(aiJudgeService.evaluateTaste).toHaveBeenCalledWith(expect.objectContaining({ mode: 'roast' }));
  });

  it('forwards the compliment mode', async () => {
    const { uhi, aiJudgeService } = build();
    await uhi.handleButton(mkButton('userhub:judge:compliment:target1'));

    expect(aiJudgeService.evaluateTaste).toHaveBeenCalledWith(expect.objectContaining({ mode: 'compliment' }));
  });

  it('passes the judge result straight through to the builder', async () => {
    const result = makeJudgeResult({ headline: 'Custom headline' });
    const { uhi } = build({ aiJudgeService: { evaluateTaste: vi.fn(async () => result) } });

    await uhi.handleButton(mkButton('userhub:judge:judge:target1'));

    expect(judgeArg().result).toBe(result);
  });

  it('prefers the cached member displayName for the target', async () => {
    const { uhi } = build();
    const press = mkButton('userhub:judge:judge:target1', {
      guild: { members: { cache: new Map([['target1', { displayName: 'Judged' }]]) } },
    });

    await uhi.handleButton(press);

    expect(judgeArg().displayName).toBe('Judged');
  });

  it('falls back to the pressing user displayName when the target is not cached', async () => {
    const { uhi } = build();
    await uhi.handleButton(mkButton('userhub:judge:judge:target1'));

    expect(judgeArg().displayName).toBe('Caller');
  });

  it('edits the reply with the ComponentsV2 container', async () => {
    const { uhi } = build();
    const press = mkButton('userhub:judge:judge:target1');

    await uhi.handleButton(press);

    expect(press.editReply).toHaveBeenCalledWith({ components: [{}] });
  });

  it('does not edit the reply when the response has no container', async () => {
    const { uhi } = build();
    vi.spyOn(UserHubBuilders, 'buildJudgeResponse').mockReturnValue({} as never);
    const press = mkButton('userhub:judge:judge:target1');

    await uhi.handleButton(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('does not fall through to the botscrobble branch', async () => {
    const { uhi, botScrobblingService } = build();
    await uhi.handleButton(mkButton('userhub:judge:judge:target1'));

    expect(botScrobblingService.toggleUserOptIn).not.toHaveBeenCalled();
    expect(UserHubBuilders.buildBotScrobblingResponse).not.toHaveBeenCalled();
  });
});

describe('UserHubInteractions.handleButton — userhub:botscrobble', () => {
  it('always looks the pressing user up, never a customId target', async () => {
    const { uhi, userService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:enable:someoneElse'));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
  });

  it('replies ephemerally when the pressing user has no lastfm account', async () => {
    const { uhi, botScrobblingService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton('userhub:botscrobble:enable');

    await uhi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Please connect your Last.fm account with `/login` first before using bot scrobbling.',
      ephemeral: true,
    });
    expect(botScrobblingService.toggleUserOptIn).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('opts the user in for the enable action', async () => {
    const { uhi, botScrobblingService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:enable'));

    expect(botScrobblingService.toggleUserOptIn).toHaveBeenCalledWith('caller1', true);
    expect(scrobbleArg().optedIn).toBe(true);
  });

  it('opts the user out for the disable action', async () => {
    const { uhi, botScrobblingService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:disable'));

    expect(botScrobblingService.toggleUserOptIn).toHaveBeenCalledWith('caller1', false);
    expect(scrobbleArg().optedIn).toBe(false);
  });

  it('opts the user out for an unrecognised action', async () => {
    const { uhi, botScrobblingService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:sideways'));

    expect(botScrobblingService.toggleUserOptIn).toHaveBeenCalledWith('caller1', false);
  });

  it('defers the update after toggling', async () => {
    const { uhi } = build();
    const press = mkButton('userhub:botscrobble:enable');

    await uhi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('reads the now playing track for the interacting guild', async () => {
    const { uhi, botScrobblingService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:enable'));

    expect(botScrobblingService.getNowPlaying).toHaveBeenCalledWith('g1');
    expect(scrobbleArg().nowPlaying).toEqual({ trackName: 'Song' });
  });

  it('skips the now playing lookup when there is no guild', async () => {
    const { uhi, botScrobblingService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:enable', { guildId: null }));

    expect(botScrobblingService.getNowPlaying).not.toHaveBeenCalled();
    expect(scrobbleArg().nowPlaying).toBeUndefined();
  });

  it('passes an undefined now playing through when the guild is idle', async () => {
    const { uhi } = build({ botScrobblingService: { getNowPlaying: vi.fn(() => undefined) } });
    await uhi.handleButton(mkButton('userhub:botscrobble:enable'));

    expect(scrobbleArg().nowPlaying).toBeUndefined();
  });

  it('edits the reply with the ComponentsV2 container', async () => {
    const { uhi } = build();
    const press = mkButton('userhub:botscrobble:enable');

    await uhi.handleButton(press);

    expect(press.editReply).toHaveBeenCalledWith({ components: [{}] });
  });

  it('does not edit the reply when the response has no container', async () => {
    const { uhi } = build();
    vi.spyOn(UserHubBuilders, 'buildBotScrobblingResponse').mockReturnValue({} as never);
    const press = mkButton('userhub:botscrobble:enable');

    await uhi.handleButton(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('does not fall through to the judge branch', async () => {
    const { uhi, aiJudgeService } = build();
    await uhi.handleButton(mkButton('userhub:botscrobble:enable'));

    expect(aiJudgeService.evaluateTaste).not.toHaveBeenCalled();
    expect(UserHubBuilders.buildJudgeResponse).not.toHaveBeenCalled();
  });
});
