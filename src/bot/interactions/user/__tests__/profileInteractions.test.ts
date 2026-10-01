import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { ProfileInteractions } from '@bot/interactions/user/profileInteractions';
import { ProfileBuilders } from '@bot/builders/user/profileBuilders';
import { ResponseModel } from '@bot/models/responseModel';
import type { ProfileStats, ProfileHistoryStats } from '@bot/builders/user/profileBuilders';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { ButtonInteraction } from 'discord.js';

const ACCENT = 0x123456;

const makeUser = (over: Partial<User> = {}): User => ({
  userId: 7,
  userNameLastFm: 'user1',
  discordUserId: 'target1',
  registeredOn: new Date('2024-01-01'),
  ...over,
}) as User;

const makeStats = (over: Partial<ProfileStats> = {}): ProfileStats => ({
  userDisplayName: 'CoolName',
  lastFmUser: { name: 'user1', playCount: 1000, imageUrl: 'https://img/large.png' },
  user: makeUser(),
  ...over,
});

const makeHistoryStats = (over: Partial<ProfileHistoryStats> = {}): ProfileHistoryStats => ({
  userDisplayName: 'CoolName',
  lastFmUser: { name: 'user1', playCount: 1000, imageUrl: 'https://img/large.png' },
  registeredUnix: 1700000000,
  user: makeUser(),
  months: [],
  years: [],
  ...over,
});

const makeResponse = (): ResponseModel =>
  new ResponseModel().setComponentsV2Container(
    new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('ok')),
  );

/** The production code mutates the stats object in place, so assert on the object. */
const colorWasUsed = (stats: ProfileStats | ProfileHistoryStats) => stats.accentColor === ACCENT;

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    getUserByLastFmName: vi.fn(async () => makeUser()),
    ...(over.userService as object),
  };
  const profileService = {
    // Params are declared so `mock.calls[0][1]` is typed - an untyped
    // `vi.fn(async () => ...)` infers a zero-length tuple and `calls[0][1]`
    // would not compile.
    getProfileStats: vi.fn(async (_displayName: string, _user: User) => makeStats()),
    getProfileHistory: vi.fn(async (_displayName: string, _user: User) => makeHistoryStats()),
    ...(over.profileService as object),
  };
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => ACCENT),
    ...(over.colorService as object),
  };
  const pi = new ProfileInteractions(userService as never, profileService as never, colorService as never);
  return { pi, userService, profileService, colorService };
};

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'caller1', displayName: 'Caller' },
    guild: { id: 'g1', name: 'TestGuild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

/** `profile:view:<target>:<caller>:<lastfm>` — five segments, as required. */
const viewId = (target = 'target1', caller = 'caller1', lastFm = 'user1') =>
  `profile:view:${target}:${caller}:${lastFm}`;

const historyId = (target = 'target1', caller = 'caller1', lastFm = 'user1') =>
  `profile:history:${target}:${caller}:${lastFm}`;

const guildWith = (member: { displayName: string } | null) => ({
  id: 'g1',
  name: 'TestGuild',
  members: { cache: new Map(), fetch: vi.fn(async () => member) },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProfileInteractions.handleButton — guards', () => {
  it('ignores a customId outside the profile namespace', async () => {
    const { pi, profileService } = build();
    const press = mkButton('settings-btn:prefix');

    await pi.handleButton(press);

    expect(profileService.getProfileStats).not.toHaveBeenCalled();
    expect(profileService.getProfileHistory).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('ignores a customId with fewer than five segments', async () => {
    const { pi, profileService } = build();
    const press = mkButton('profile:view:target1:caller1');

    await pi.handleButton(press);

    expect(profileService.getProfileStats).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('refuses a tab toggle requested by someone other than the caller', async () => {
    const { pi, profileService } = build();
    const press = mkButton(viewId('target1', 'someoneElse'));

    await pi.handleButton(press);

    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Only the user who requested this profile can toggle tabs.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(profileService.getProfileStats).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('treats caller "0" as a wildcard anyone may act on', async () => {
    const { pi, profileService } = build();
    const press = mkButton(viewId('target1', '0'));

    await pi.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(profileService.getProfileStats).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileInteractions.handleButton — target resolution', () => {
  it('resolves the target by Discord id when one is present', async () => {
    const { pi, userService } = build();
    const press = mkButton(viewId('target1', 'caller1'));

    await pi.handleButton(press);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('target1');
    expect(userService.getUserByLastFmName).not.toHaveBeenCalled();
  });

  it('resolves the target by Last.fm name when the Discord id is "0"', async () => {
    const { pi, userService } = build();
    const press = mkButton(viewId('0', 'caller1', 'somebody'));

    await pi.handleButton(press);

    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('somebody');
    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
  });

  it('synthesises a placeholder user when the Discord lookup misses', async () => {
    const { pi, profileService } = build({
      userService: { getUserByDiscordId: vi.fn(async () => null) },
    });
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const press = mkButton(viewId('ghost1', 'caller1', 'ghostfm'));

    await pi.handleButton(press);

    // The placeholder is the 2nd argument handed to the service; the builder
    // never sees it directly, so assert on the service call.
    const target = profileService.getProfileStats.mock.calls[0]![1] as User;
    expect(target).toMatchObject({
      userId: 0,
      userNameLastFm: 'ghostfm',
      discordUserId: 'ghost1',
    });
  });

  it('leaves discordUserId undefined on the placeholder for a "0" target', async () => {
    const { pi, profileService } = build({
      userService: { getUserByLastFmName: vi.fn(async () => null) },
    });
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const press = mkButton(viewId('0', 'caller1', 'ghostfm'));

    await pi.handleButton(press);

    const target = profileService.getProfileStats.mock.calls[0]![1] as User;
    expect(target).toMatchObject({ userId: 0, userNameLastFm: 'ghostfm' });
    expect(target.discordUserId).toBeUndefined();
  });
});

describe('ProfileInteractions.handleButton — display name', () => {
  it('prefers the cached guild member display name', async () => {
    const { pi, profileService } = build();
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const press = mkButton(viewId('target1', 'caller1'), { guild: guildWith({ displayName: 'CoolName' }) });

    await pi.handleButton(press);

    expect(profileService.getProfileStats).toHaveBeenCalledWith('CoolName', expect.objectContaining({ userId: 7 }));
  });

  it('falls back to the Last.fm name when the member fetch rejects', async () => {
    const { pi, profileService } = build();
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const press = mkButton(viewId('target1', 'caller1', 'user1'), {
      guild: {
        id: 'g1',
        name: 'TestGuild',
        members: {
          cache: new Map(),
          fetch: vi.fn(async () => {
            throw new Error('Unknown Member');
          }),
        },
      },
    });

    await pi.handleButton(press);

    expect(profileService.getProfileStats).toHaveBeenCalledWith('user1', expect.anything());
  });

  it('does not fetch a member when there is no guild', async () => {
    const { pi } = build();
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const fetch = vi.fn(async () => ({ displayName: 'CoolName' }));
    const press = mkButton(viewId('target1', 'caller1'), {
      guild: null,
      guildId: null,
      members: { fetch },
    });

    await pi.handleButton(press);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fetch a member for a "0" target', async () => {
    const { pi } = build();
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const fetch = vi.fn(async () => ({ displayName: 'CoolName' }));
    const press = mkButton(viewId('0', 'caller1', 'somebody'), { members: { fetch } });

    await pi.handleButton(press);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ProfileInteractions.handleButton — profile:view path', () => {
  it('fetches profile stats and publishes the ComponentsV2 container', async () => {
    const { pi, profileService, colorService } = build();
    const response = makeResponse();
    const spy = vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(response);
    const press = mkButton(viewId());

    await pi.handleButton(press);

    expect(profileService.getProfileStats).toHaveBeenCalledTimes(1);
    expect(profileService.getProfileHistory).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/large.png');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe('caller1');
    expect(press.update).toHaveBeenCalledWith({
      components: [response.componentsV2Container],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  it('writes the resolved accent colour back onto the stats', async () => {
    const stats = makeStats();
    const { pi } = build({ profileService: { getProfileStats: vi.fn(async () => stats) } });
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(makeResponse());
    const press = mkButton(viewId());

    await pi.handleButton(press);

    expect(stats.accentColor).toBe(ACCENT);
    expect(colorWasUsed(stats)).toBe(true);
  });

  it('falls back to embeds and action rows when the builder returns no container', async () => {
    const { pi } = build();
    const legacy = new ResponseModel();
    vi.spyOn(ProfileBuilders, 'buildProfileResponse').mockReturnValue(legacy);
    const press = mkButton(viewId());

    await pi.handleButton(press);

    expect(press.update).toHaveBeenCalledWith({
      embeds: [legacy.embed],
      components: [],
    });
  });

  it('defers and stops when there are no profile stats', async () => {
    const { pi, colorService } = build({
      profileService: { getProfileStats: vi.fn(async () => null) },
    });
    const press = mkButton(viewId());

    await pi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
  });

  it('swallows a rejected deferUpdate when there are no stats', async () => {
    const { pi } = build({
      profileService: { getProfileStats: vi.fn(async () => null) },
    });
    const press = mkButton(viewId(), {
      deferUpdate: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

    await expect(pi.handleButton(press)).resolves.toBeUndefined();
  });
});

describe('ProfileInteractions.handleButton — profile:history path', () => {
  it('fetches history and publishes the ComponentsV2 container', async () => {
    const { pi, profileService, colorService } = build();
    const response = makeResponse();
    const spy = vi.spyOn(ProfileBuilders, 'buildProfileHistoryResponse').mockReturnValue(response);
    const press = mkButton(historyId());

    await pi.handleButton(press);

    expect(profileService.getProfileHistory).toHaveBeenCalledTimes(1);
    expect(profileService.getProfileStats).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/large.png');
    expect(spy.mock.calls[0]![1]).toBe('caller1');
    expect(press.update).toHaveBeenCalledWith({
      components: [response.componentsV2Container],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  it('writes the resolved accent colour back onto the history stats', async () => {
    const stats = makeHistoryStats();
    const { pi } = build({ profileService: { getProfileHistory: vi.fn(async () => stats) } });
    vi.spyOn(ProfileBuilders, 'buildProfileHistoryResponse').mockReturnValue(makeResponse());
    const press = mkButton(historyId());

    await pi.handleButton(press);

    expect(stats.accentColor).toBe(ACCENT);
  });

  it('falls back to embeds and action rows when the builder returns no container', async () => {
    const { pi } = build();
    const legacy = new ResponseModel();
    vi.spyOn(ProfileBuilders, 'buildProfileHistoryResponse').mockReturnValue(legacy);
    const press = mkButton(historyId());

    await pi.handleButton(press);

    expect(press.update).toHaveBeenCalledWith({ embeds: [legacy.embed], components: [] });
  });

  it('defers and stops when there is no history', async () => {
    const { pi } = build({
      profileService: { getProfileHistory: vi.fn(async () => null) },
    });
    const press = mkButton(historyId());

    await pi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('passes the wildcard caller through to the builder unchanged', async () => {
    const { pi } = build();
    const spy = vi.spyOn(ProfileBuilders, 'buildProfileHistoryResponse').mockReturnValue(makeResponse());
    const press = mkButton(historyId('target1', '0'));

    await pi.handleButton(press);

    expect(spy.mock.calls[0]![1]).toBe('0');
  });
});
