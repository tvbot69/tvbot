import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserHubInteractions } from '../userHubInteractions';
import { UserHubBuilders } from '@bot/builders/userHubBuilders';
import type { ButtonInteraction } from 'discord.js';

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
    botScrobblingService as never,
    userService as never,
    injected as never,
  );
  return { uhi, botScrobblingService, userService, colorService };
};

const scrobbleArg = () =>
  (UserHubBuilders.buildBotScrobblingResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    optedIn: boolean;
    nowPlaying: unknown;
    accentColor: number | null;
  };

beforeEach(() => {
  vi.restoreAllMocks();
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

  it('passes the resolved accent colour to the builder', async () => {
    const { uhi, colorService } = build({ colorService: { getAccentColorAsync: vi.fn(async () => 0x0abcde) } });

    await uhi.handleButton(mkButton('userhub:botscrobble:enable'));
    expect(scrobbleArg().accentColor).toBe(0x0abcde);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('g1');
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
});
