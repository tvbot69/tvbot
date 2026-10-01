import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { MessageFlags } from 'discord.js';
import { PlaycountInteractions } from '@bot/interactions/library/playcountInteractions';
import { PlaycountBuilders } from '@bot/builders/library/playcountBuilders';
import { UserType, DataSource } from '@persistence/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { User } from '@persistence/models/user';
import type { RecentTrack } from '@domain/models/recentTrack';
import type { LastFmUser } from '@domain/models/lastFmUser';
import type { ButtonInteraction } from 'discord.js';

const TARGET_USER_ID = 2;
const CALLER_USER_ID = 1;

const makeUser = (over: Partial<User> = {}): User => ({
  userId: 1,
  userNameLastFm: 'user1',
  discordUserId: 'caller1',
  registeredOn: new Date('2025-01-01'),
  sessionKey: 'session-key',
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  ...over,
});

const makeTrack = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Creep',
  artistName: 'Radiohead',
  albumName: 'Pablo Honey',
  nowPlaying: false,
  timePlayed: new Date('2025-06-01T10:00:00Z'),
  ...over,
});

const makeLastFmUser = (over: Partial<LastFmUser> = {}): LastFmUser => ({
  name: 'user1',
  playCount: 1000,
  ...over,
});

const makeButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    guild: { name: 'TestGuild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const rerollId = (targetUserId = TARGET_USER_ID, callerUserId = CALLER_USER_ID) =>
  `milestone:reroll:${targetUserId}:${callerUserId}`;

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserById: vi.fn(async (id: number) =>
      id === TARGET_USER_ID ? makeUser({ userId: TARGET_USER_ID, discordUserId: 'target1' }) : makeUser(),
    ),
    ...(over.userService as object),
  };
  const playHistoryService = {
    getMilestoneScrobble: vi.fn(async () => makeTrack()),
    ...(over.playHistoryService as object),
  };
  const artworkService = {
    getAlbumCoverUrl: vi.fn(async () => 'https://art.example/album.jpg'),
    getTrackCoverUrl: vi.fn(async () => 'https://art.example/track.jpg'),
    ...(over.artworkService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const lastfmRepo = {
    getUserInfo: vi.fn(async () => makeLastFmUser()),
    ...(over.lastfmRepo as object),
  };
  const pi = new PlaycountInteractions(
    userService as never,
    playHistoryService as never,
    artworkService as never,
    colorService as never,
    lastfmRepo as never,
  );
  return { pi, userService, playHistoryService, artworkService, colorService, lastfmRepo };
};

const targetUserService = (user: User | null) => ({
  getUserById: vi.fn(async (id: number) => (id === CALLER_USER_ID ? makeUser() : user)),
});

let milestoneSpy: MockInstance<typeof PlaycountBuilders.buildMilestoneResponse>;

beforeEach(() => {
  vi.restoreAllMocks();
  milestoneSpy = vi
    .spyOn(PlaycountBuilders, 'buildMilestoneResponse')
    .mockReturnValue({ toMessagePayload: () => ({ embeds: [] }) } as unknown as ReturnType<
      typeof PlaycountBuilders.buildMilestoneResponse
    >);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlaycountInteractions.handleButton — routing guards', () => {
  it('returns early when the customId is not a milestone reroll', async () => {
    const { pi, userService } = build();
    const press = makeButton('something-else');

    await pi.handleButton(press);

    expect(userService.getUserById).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('returns early when the customId has fewer than 4 parts', async () => {
    const { pi, userService } = build();
    const press = makeButton('milestone:reroll:2');

    await pi.handleButton(press);

    expect(userService.getUserById).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('looks up the caller before the target', async () => {
    const { pi, userService } = build();
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(userService.getUserById).toHaveBeenNthCalledWith(1, CALLER_USER_ID);
    expect(userService.getUserById).toHaveBeenNthCalledWith(2, TARGET_USER_ID);
  });

  it('parses both ids out of the customId', async () => {
    const { pi, userService } = build();
    const press = makeButton(rerollId(77, 88));

    await pi.handleButton(press);

    expect(userService.getUserById).toHaveBeenNthCalledWith(1, 88);
    expect(userService.getUserById).toHaveBeenNthCalledWith(2, 77);
  });
});

describe('PlaycountInteractions.handleButton — reroll ownership', () => {
  it('replies ephemerally when a different discord user presses reroll', async () => {
    const { pi, lastfmRepo } = build({
      userService: {
        getUserById: vi.fn(async (id: number) =>
          id === CALLER_USER_ID
            ? makeUser({ discordUserId: 'someoneelse' })
            : makeUser({ userId: TARGET_USER_ID, discordUserId: 'target1' }),
        ),
      },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(press.reply).toHaveBeenCalledTimes(1);
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Only the user who initiated this command can reroll.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(lastfmRepo.getUserInfo).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('does not reply when the presser matches the caller discordUserId', async () => {
    const { pi } = build();
    const button = makeButton(rerollId());

    await pi.handleButton(button);

    expect(button.reply).not.toHaveBeenCalled();
    expect(button.update).toHaveBeenCalledTimes(1);
  });

  it('does not reply when the caller record is missing', async () => {
    const { pi } = build({
      userService: {
        getUserById: vi.fn(async (id: number) =>
          id === CALLER_USER_ID ? null : makeUser({ userId: TARGET_USER_ID, discordUserId: 'target1' }),
        ),
      },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).toHaveBeenCalledTimes(1);
  });
});

describe('PlaycountInteractions.handleButton — missing target or scrobble data', () => {
  it('defers update when the target user does not exist', async () => {
    const { pi, lastfmRepo } = build({ userService: targetUserService(null) });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(lastfmRepo.getUserInfo).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('defers update when the lastfm user info is missing', async () => {
    const { pi, playHistoryService } = build({ lastfmRepo: { getUserInfo: vi.fn(async () => null) } });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(playHistoryService.getMilestoneScrobble).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('defers update when the lastfm playcount is zero', async () => {
    const { pi, playHistoryService } = build({
      lastfmRepo: { getUserInfo: vi.fn(async () => makeLastFmUser({ playCount: 0 })) },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(playHistoryService.getMilestoneScrobble).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('defers update when the milestone scrobble cannot be resolved', async () => {
    const { pi, artworkService } = build({
      playHistoryService: { getMilestoneScrobble: vi.fn(async () => null) },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(artworkService.getAlbumCoverUrl).not.toHaveBeenCalled();
    expect(artworkService.getTrackCoverUrl).not.toHaveBeenCalled();
    expect(milestoneSpy).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('swallows a deferUpdate rejection instead of propagating it', async () => {
    const { pi } = build({ playHistoryService: { getMilestoneScrobble: vi.fn(async () => null) } });
    const press = makeButton(rerollId(), {
      deferUpdate: vi.fn(async () => {
        throw new Error('already acknowledged');
      }),
    });

    await expect(pi.handleButton(press)).resolves.toBeUndefined();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('defers update when the milestone lookup throws', async () => {
    const { pi } = build({
      playHistoryService: {
        getMilestoneScrobble: vi.fn(async () => {
          throw new Error('lastfm exploded');
        }),
      },
    });
    const press = makeButton(rerollId());

    await expect(pi.handleButton(press)).resolves.toBeUndefined();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('defers update when the lastfm user info call throws', async () => {
    const { pi } = build({
      lastfmRepo: {
        getUserInfo: vi.fn(async () => {
          throw new Error('network down');
        }),
      },
    });
    const press = makeButton(rerollId());

    await expect(pi.handleButton(press)).resolves.toBeUndefined();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('PlaycountInteractions.handleButton — milestone resolution', () => {
  it('resolves the milestone scrobble with the target session key and playcount', async () => {
    const { pi, playHistoryService } = build();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(playHistoryService.getMilestoneScrobble).toHaveBeenCalledWith('user1', 'session-key', 1000, 501);
    randomSpy.mockRestore();
  });

  it('scales the random milestone by the lastfm playcount', async () => {
    const { pi, playHistoryService } = build({
      lastfmRepo: { getUserInfo: vi.fn(async () => makeLastFmUser({ playCount: 4 })) },
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(playHistoryService.getMilestoneScrobble).toHaveBeenCalledWith('user1', 'session-key', 4, 4);
    randomSpy.mockRestore();
  });

  it('passes a null session key when the target has none', async () => {
    const { pi, playHistoryService } = build({
      userService: {
        getUserById: vi.fn(async (id: number) =>
          id === CALLER_USER_ID
            ? makeUser()
            : makeUser({ userId: TARGET_USER_ID, discordUserId: 'target1', sessionKey: undefined }),
        ),
      },
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(playHistoryService.getMilestoneScrobble).toHaveBeenCalledWith('user1', null, 1000, 1);
    randomSpy.mockRestore();
  });

  it('looks up lastfm info using the target username, not the caller', async () => {
    const { pi, lastfmRepo } = build({
      userService: {
        getUserById: vi.fn(async (id: number) =>
          id === CALLER_USER_ID
            ? makeUser({ userNameLastFm: 'callerLastFm' })
            : makeUser({ userId: TARGET_USER_ID, userNameLastFm: 'targetLastFm', discordUserId: 'target1' }),
        ),
      },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(lastfmRepo.getUserInfo).toHaveBeenCalledWith('targetLastFm');
  });
});

describe('PlaycountInteractions.handleButton — artwork', () => {
  it('uses the album cover when the album name is present', async () => {
    const { pi, artworkService } = build();
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('Pablo Honey', 'Radiohead');
    expect(artworkService.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('skips the album lookup entirely when the album name is empty', async () => {
    const { pi, artworkService } = build({
      playHistoryService: { getMilestoneScrobble: vi.fn(async () => makeTrack({ albumName: '' })) },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(artworkService.getAlbumCoverUrl).not.toHaveBeenCalled();
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('Creep', 'Radiohead');
  });

  it('falls back to the track cover when the album lookup finds nothing', async () => {
    const { pi, artworkService } = build({
      artworkService: { getAlbumCoverUrl: vi.fn(async () => null) },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledTimes(1);
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('Creep', 'Radiohead');
    expect(milestoneSpy.mock.calls[0]![7]).toBe('https://art.example/track.jpg');
  });
});

describe('PlaycountInteractions.handleButton — accent colour', () => {
  it('asks for the target discord colour first and stops when it resolves', async () => {
    const { pi, colorService } = build();
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(1);
    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('target1');
    expect(milestoneSpy.mock.calls[0]![8]).toBe(0xff0000);
  });

  it('falls back to the guild accent colour when the user has none', async () => {
    const { pi, colorService } = build({
      colorService: { getAccentColorAsync: vi.fn(async () => null) },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(2);
    expect(colorService.getAccentColorAsync).toHaveBeenNthCalledWith(1, 'target1');
    expect(colorService.getAccentColorAsync).toHaveBeenNthCalledWith(2, 'g1');
  });

  it('uses the presser id for colour when the target has no discord link', async () => {
    const { pi, colorService } = build({
      userService: {
        getUserById: vi.fn(async (id: number) =>
          id === CALLER_USER_ID ? makeUser() : makeUser({ userId: TARGET_USER_ID, discordUserId: '' }),
        ),
      },
    });
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('caller1');
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('does not ask for a guild colour outside a guild', async () => {
    const { pi, colorService } = build({
      colorService: { getAccentColorAsync: vi.fn(async () => null) },
    });
    const press = makeButton(rerollId(), { guildId: null });

    await pi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(1);
    expect(milestoneSpy.mock.calls[0]![8]).toBeUndefined();
  });
});

describe('PlaycountInteractions.handleButton — display name resolution', () => {
  it('passes the cached member displayName to the builder', async () => {
    const { pi } = build();
    const press = makeButton(rerollId(), {
      guild: { name: 'TestGuild', members: { cache: new Map([['target1', { displayName: 'CoolName' }]]) } },
    });

    await pi.handleButton(press);

    expect(milestoneSpy).toHaveBeenCalledTimes(1);
    expect(milestoneSpy.mock.calls[0]![0]).toBe('CoolName');
  });

  it('falls back to the last.fm username when the member is not cached', async () => {
    const { pi } = build();
    const press = makeButton(rerollId(), { guild: { name: 'TestGuild', members: { cache: new Map() } } });

    await pi.handleButton(press);

    expect(milestoneSpy.mock.calls[0]![0]).toBe('user1');
  });

  it('falls back to the last.fm username when the interaction carries no guild', async () => {
    const { pi } = build();
    const press = makeButton(rerollId(), { guild: null });

    await pi.handleButton(press);

    expect(milestoneSpy.mock.calls[0]![0]).toBe('user1');
  });
});

describe('PlaycountInteractions.handleButton — buildMilestoneResponse arguments', () => {
  it('passes the resolved milestone scrobble and ids to the builder', async () => {
    const { pi } = build();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(milestoneSpy).toHaveBeenCalledTimes(1);
    const call = milestoneSpy.mock.calls[0]!;
    expect(call[0]).toBe('user1');
    expect(call[1]).toBe('user1');
    expect(call[2]).toBe(1);
    expect(call[3]).toBe('Radiohead');
    expect(call[4]).toBe('Pablo Honey');
    expect(call[5]).toBe('Creep');
    expect(call[6]).toEqual(new Date('2025-06-01T10:00:00Z'));
    expect(call[7]).toBe('https://art.example/album.jpg');
    expect(call[8]).toBe(0xff0000);
    expect(call[9]).toBe(true);
    expect(call[10]).toBe(TARGET_USER_ID);
    expect(call[11]).toBe(CALLER_USER_ID);
    randomSpy.mockRestore();
  });

  it('updates the interaction with the built milestone payload', async () => {
    const { pi } = build();
    const press = makeButton(rerollId());

    await pi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledWith({ embeds: [] });
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });
});
