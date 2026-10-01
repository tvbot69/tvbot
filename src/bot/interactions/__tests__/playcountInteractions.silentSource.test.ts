/**
 * `PlaycountInteractions.handleButton` reads `lastfmRepo.getUserInfo` inside a
 * `try` whose catch was a bare `{ await interaction.deferUpdate(); }`.
 *
 * `getUserInfo` RAISES `LastFmUnavailableError` on anything that is not a
 * genuine "no such user" - the repository draws that line deliberately so a 5xx
 * cannot read as a deleted account. Swallowing the raise here undid it, and
 * worse: the two HONEST absences right above the catch, `!userInfo` and
 * `playCount < 1`, both defer the update the same way. So a Last.fm outage, a
 * genuinely unknown listener and a listener with zero plays were three
 * different facts rendering as the identical nothing. The catch is now narrowed
 * with `isSourceUnavailable`, so the deliberate signal reaches
 * `interactionHandler.onInteractionCreated` while a genuine query failure still
 * degrades.
 *
 * BOTH DIRECTIONS. Pinning only the raise would pass against a blanket
 * `throw err`, which would break every ordinary failure; pinning only the
 * degrade would pass against the bug. So: the raise is pinned, a plain failure
 * still defers, and BOTH honest absences still defer.
 *
 * Plain object doubles, built fresh per test, handed to the five-argument
 * constructor in its real order (userService, playHistoryService,
 * artworkService, colorService, lastfmRepo). The only spy is the
 * `PlaycountBuilders` static, which holds no state.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaycountInteractions } from '../playcountInteractions';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { ButtonInteraction } from 'discord.js';

const LFM_DOWN = (): LastFmUnavailableError =>
  new LastFmUnavailableError('user.getinfo', new Error('Last.fm returned HTTP 500'));

const USER = { userId: 2, userNameLastFm: 'targetLastFm', discordUserId: 'target1', sessionKey: 'sk' };
const SCROBBLE = {
  name: 'Creep', artistName: 'Radiohead', albumName: 'Pablo Honey',
  nowPlaying: false, timePlayed: new Date('2025-06-01T10:00:00Z'),
};

const MILESTONE_PAYLOAD = { embeds: [{ title: 'milestone' }] };

const mkButton = (customId: string) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1' },
    guild: { name: 'TestGuild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserById: vi.fn(async (id: number) =>
      id === 1
        ? { userId: 1, userNameLastFm: 'callerLastFm', discordUserId: 'u1', sessionKey: 'sk' }
        : USER),
    ...(over.userService as object),
  };
  const playHistoryService = {
    getMilestoneScrobble: vi.fn(async () => SCROBBLE),
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
    getUserInfo: vi.fn(async () => ({ name: 'targetLastFm', playCount: 1000 })),
    ...(over.lastfmRepo as object),
  };
  const service = new PlaycountInteractions(
    userService as never,
    playHistoryService as never,
    artworkService as never,
    colorService as never,
    lastfmRepo as never,
  );
  return { service, userService, playHistoryService, lastfmRepo };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(PlaycountBuilders, 'buildMilestoneResponse').mockReturnValue({
    toMessagePayload: () => MILESTONE_PAYLOAD,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REROLL = 'milestone:reroll:2:1';

describe('PlaycountInteractions.handleButton — a Last.fm outage is not "nothing to show"', () => {
  it('re-throws the deliberate signal instead of silently doing nothing', async () => {
    const { service, playHistoryService } = build({
      lastfmRepo: { getUserInfo: vi.fn(async () => { throw LFM_DOWN(); }) },
    });
    const press = mkButton(REROLL);

    await expect(service.handleButton(press)).rejects.toSatisfy(isSourceUnavailable);

    // No local ack either: the throw has to leave this handler for the boundary
    // to answer the presser.
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(playHistoryService.getMilestoneScrobble).not.toHaveBeenCalled();
  });

  it('still degrades a genuine query failure to a deferred update', async () => {
    // The other half of the pair. Narrowing the catch to `isSourceUnavailable`
    // must not have turned an ordinary failure into a raised one, and this is
    // what proves the re-throw is narrow rather than blanket.
    const { service } = build({
      lastfmRepo: { getUserInfo: vi.fn(async () => { throw new Error("Can't reach database server"); }) },
    });
    const press = mkButton(REROLL);

    await expect(service.handleButton(press)).resolves.toBeUndefined();

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('still defers for a genuinely unknown listener, which Last.fm reports as null', async () => {
    // The honest empty, and the case the laundering destroyed: `null` is what
    // `user.getinfo` code 6 looks like, and it must keep deferring quietly.
    const { service, playHistoryService } = build({
      lastfmRepo: { getUserInfo: vi.fn(async () => null) },
    });
    const press = mkButton(REROLL);

    await expect(service.handleButton(press)).resolves.toBeUndefined();

    expect(playHistoryService.getMilestoneScrobble).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('still defers for a listener with a real playcount of zero', async () => {
    const { service, playHistoryService } = build({
      lastfmRepo: { getUserInfo: vi.fn(async () => ({ name: 'targetLastFm', playCount: 0 })) },
    });
    const press = mkButton(REROLL);

    await expect(service.handleButton(press)).resolves.toBeUndefined();

    expect(playHistoryService.getMilestoneScrobble).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('still rerolls when the read ran and answered', async () => {
    const { service, playHistoryService } = build();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const press = mkButton(REROLL);

    await expect(service.handleButton(press)).resolves.toBeUndefined();

    expect(playHistoryService.getMilestoneScrobble).toHaveBeenCalledWith('targetLastFm', 'sk', 1000, 501);
    expect(press.update).toHaveBeenCalledWith(MILESTONE_PAYLOAD);
    expect(press.deferUpdate).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });
});
