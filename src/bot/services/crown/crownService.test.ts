import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrownService } from './crownService';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { Guild } from '@persistence/domain/models/guild';
import type { UserCrownDto } from '@domain/models/crownModels';

describe('CrownService', () => {
  let crownRepoMock: any;
  let userServiceMock: any;
  let crownService: CrownService;

  const mockGuild: Guild = {
    guildId: '123456789' as any,
    guildName: 'Test Guild',
    crownsDisabled: false,
    crownsMinimumPlaycountThreshold: 30,
  } as any;

  beforeEach(() => {
    crownRepoMock = {
      getCurrentCrown: vi.fn(),
      createCrown: vi.fn(),
      deactivateCrown: vi.fn(),
      updateCrownPlaycount: vi.fn(),
      getUserCrowns: vi.fn(),
      getTopCrownHoldersInGuild: vi.fn(),
      getTotalActiveCrownsInGuild: vi.fn(),
      getCrownHistoryForArtist: vi.fn(),
      seedCrownsForGuild: vi.fn(),
    };
    userServiceMock = {
      getUserById: vi.fn(),
      getUserByDiscordId: vi.fn(),
    };
    crownService = new CrownService(crownRepoMock, userServiceMock);
  });

  it('claims a crown when top user has >= 30 plays and no crown exists', async () => {
    crownRepoMock.getCurrentCrown.mockResolvedValue(null);
    crownRepoMock.createCrown.mockImplementation((data: any) =>
      Promise.resolve({
        crownId: 1,
        ...data,
        created: new Date(),
        modified: new Date(),
        active: true,
      }),
    );

    const users: WhoKnowsUser[] = [
      { userId: 10, playcount: 50, lastFmUsername: 'moha', discordName: 'moha' },
    ];
    const guildUsers = new Map<number, FullGuildUserDetails>();

    const result = await crownService.getAndUpdateCrownForArtist(users, guildUsers, mockGuild, 'TV Girl');

    expect(result).not.toBeNull();
    expect(result?.claimed).toBe(true);
    expect(result?.crownResult).toContain('Crown claimed by **moha**');
    expect(crownRepoMock.createCrown).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        artistName: 'TV Girl',
        startPlaycount: 50,
        currentPlaycount: 50,
      }),
    );
  });

  it('steals a crown when competitor overtakes previous crown holder', async () => {
    const existingCrown: UserCrownDto = {
      crownId: 1,
      guildId: '123456789',
      userId: 5,
      artistName: 'TV Girl',
      currentPlaycount: 40,
      startPlaycount: 35,
      created: new Date(),
      modified: new Date(),
      active: true,
      seededCrown: false,
      userNameLastFm: 'previousOwner',
    };
    crownRepoMock.getCurrentCrown.mockResolvedValue(existingCrown);
    crownRepoMock.createCrown.mockImplementation((data: any) =>
      Promise.resolve({
        crownId: 2,
        ...data,
        created: new Date(),
        modified: new Date(),
        active: true,
      }),
    );

    const users: WhoKnowsUser[] = [
      { userId: 10, playcount: 45, lastFmUsername: 'moha', discordName: 'moha' },
      { userId: 5, playcount: 40, lastFmUsername: 'previousOwner', discordName: 'previousOwner' },
    ];
    const guildUsers = new Map<number, FullGuildUserDetails>();

    const result = await crownService.getAndUpdateCrownForArtist(users, guildUsers, mockGuild, 'TV Girl');

    expect(result).not.toBeNull();
    expect(result?.stolen).toBe(true);
    expect(result?.crownResult).toContain('Crown stolen by **moha** with 45 plays!');
    expect(crownRepoMock.deactivateCrown).toHaveBeenCalledWith(1);
    expect(crownRepoMock.createCrown).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        artistName: 'TV Girl',
        startPlaycount: 45,
        currentPlaycount: 45,
      }),
    );
  });

  it('updates playcount when the current owner plays more', async () => {
    const existingCrown: UserCrownDto = {
      crownId: 1,
      guildId: '123456789',
      userId: 10,
      artistName: 'TV Girl',
      currentPlaycount: 50,
      startPlaycount: 50,
      created: new Date(),
      modified: new Date(),
      active: true,
      seededCrown: false,
    };
    crownRepoMock.getCurrentCrown.mockResolvedValue(existingCrown);

    const users: WhoKnowsUser[] = [
      { userId: 10, playcount: 75, lastFmUsername: 'moha', discordName: 'moha' },
    ];
    const guildUsers = new Map<number, FullGuildUserDetails>();

    const result = await crownService.getAndUpdateCrownForArtist(users, guildUsers, mockGuild, 'TV Girl');

    expect(result).not.toBeNull();
    expect(result?.stolen).toBeUndefined();
    expect(crownRepoMock.updateCrownPlaycount).toHaveBeenCalledWith(1, 75);
    expect(result?.crown.currentPlaycount).toBe(75);
  });

  it('does not steal crown if competitor has fewer plays than current holder', async () => {
    const existingCrown: UserCrownDto = {
      crownId: 1,
      guildId: '123456789',
      userId: 10,
      artistName: 'TV Girl',
      currentPlaycount: 100,
      startPlaycount: 50,
      created: new Date(),
      modified: new Date(),
      active: true,
      seededCrown: false,
    };
    crownRepoMock.getCurrentCrown.mockResolvedValue(existingCrown);

    const users: WhoKnowsUser[] = [
      { userId: 20, playcount: 80, lastFmUsername: 'challenger', discordName: 'challenger' },
    ];
    const guildUsers = new Map<number, FullGuildUserDetails>();

    const result = await crownService.getAndUpdateCrownForArtist(users, guildUsers, mockGuild, 'TV Girl');

    expect(result).not.toBeNull();
    expect(result?.stolen).toBeUndefined();
    expect(crownRepoMock.deactivateCrown).not.toHaveBeenCalled();
    expect(result?.crown.userId).toBe(10);
  });

  it('reports remaining plays when top user has between min/3 and min plays', async () => {
    crownRepoMock.getCurrentCrown.mockResolvedValue(null);

    const users: WhoKnowsUser[] = [
      { userId: 10, playcount: 18, lastFmUsername: 'moha', discordName: 'moha' },
    ];
    const guildUsers = new Map<number, FullGuildUserDetails>();

    const result = await crownService.getAndUpdateCrownForArtist(users, guildUsers, mockGuild, 'TV Girl');

    expect(result).not.toBeNull();
    expect(result?.crownResult).toContain('**moha** needs 12 more plays to claim the crown');
    expect(crownRepoMock.createCrown).not.toHaveBeenCalled();
  });
});
