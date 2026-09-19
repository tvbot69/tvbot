import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CrownService } from './crownService';

const guild = { guildId: '1445761601129943222' } as never;
const guildUsers = new Map();

const holderCrown = () => ({
  crownId: 5,
  guildId: '1445761601129943222',
  userId: 1,
  artistName: 'Mond',
  currentPlaycount: 100,
  startPlaycount: 90,
  created: new Date(),
  modified: new Date(),
  active: true,
  seededCrown: false,
  userNameLastFm: 'holder',
  discordUserId: '111',
});

const challenger = () => [
  {
    userId: 2,
    playcount: 150,
    lastFmUsername: 'challenger',
    discordName: 'Challenger',
    discordUserId: '222',
  },
];

const makeService = (overrides: {
  holderLive?: number | null;
  elevated?: boolean;
  replaceResult?: unknown;
}) => {
  const replaceCrown = vi.fn(async () => overrides.replaceResult ?? {
    ...holderCrown(),
    crownId: 6,
    userId: 2,
    currentPlaycount: 150,
    startPlaycount: 150,
  });
  const updateCrownPlaycount = vi.fn(async () => undefined);
  const service = new CrownService(
    {
      getCurrentCrown: vi.fn(async () => holderCrown()),
      deactivateCrown: vi.fn(async () => undefined),
      createCrown: vi.fn(),
      updateCrownPlaycount,
      replaceCrown,
    } as never,
    {} as never,
    {
      getArtistInfo: vi.fn(async () =>
        overrides.holderLive === undefined || overrides.holderLive === null
          ? null
          : { userPlayCount: overrides.holderLive },
      ),
    } as never,
    { isElevated: vi.fn(() => overrides.elevated ?? false) } as never,
  );
  return { service, replaceCrown, updateCrownPlaycount };
};

describe('CrownService steal hardening (Phase 0.4)', () => {
  it('keeps the holder when their live playcount beats the challenger', async () => {
    const { service, replaceCrown, updateCrownPlaycount } = makeService({ holderLive: 200 });

    const res = await service.getAndUpdateCrownForArtist(challenger() as never, guildUsers, guild, 'Mond');

    expect(res?.stolen).toBeFalsy();
    expect(res?.crown.userId).toBe(1);
    expect(replaceCrown).not.toHaveBeenCalled();
    expect(updateCrownPlaycount).toHaveBeenCalledWith(5, 200);
  });

  it('proceeds atomically when the live check is unreachable (fail-open)', async () => {
    const { service, replaceCrown } = makeService({ holderLive: null });

    const res = await service.getAndUpdateCrownForArtist(challenger() as never, guildUsers, guild, 'Mond');

    expect(res?.stolen).toBe(true);
    expect(replaceCrown).toHaveBeenCalledTimes(1);
  });

  it('refuses to steal while the Last.fm error rate is elevated', async () => {
    const { service, replaceCrown } = makeService({ holderLive: 50, elevated: true });

    const res = await service.getAndUpdateCrownForArtist(challenger() as never, guildUsers, guild, 'Mond');

    expect(res?.stolen).toBeFalsy();
    expect(res?.crown.userId).toBe(1);
    expect(replaceCrown).not.toHaveBeenCalled();
  });

  it('re-reads the winner when losing an atomic steal race', async () => {
    const winnerCrown = { ...holderCrown(), userId: 3, userNameLastFm: 'racer' };
    const getCurrentCrown = vi.fn(async () => winnerCrown);
    const service = new CrownService(
      {
        getCurrentCrown,
        deactivateCrown: vi.fn(async () => undefined),
        createCrown: vi.fn(),
        updateCrownPlaycount: vi.fn(async () => undefined),
        replaceCrown: vi.fn(async () => null),
      } as never,
      {} as never,
      { getArtistInfo: vi.fn(async () => ({ userPlayCount: 50 })) } as never,
      { isElevated: vi.fn(() => false) } as never,
    );

    const res = await service.getAndUpdateCrownForArtist(challenger() as never, guildUsers, guild, 'Mond');

    expect(res?.stolen).toBeFalsy();
    expect(res?.crown.userId).toBe(3);
    expect(getCurrentCrown).toHaveBeenCalledTimes(2);
  });
});
