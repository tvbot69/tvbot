import { describe, it, expect } from 'vitest';
import { ProfileBuilders } from './profileBuilders';
import type { LastFmUser } from '@domain/models/lastFmUser';
import { UserType } from '@persistence/domain/models/user';

describe('ProfileBuilders', () => {
  const mockLfmUser: LastFmUser = {
    name: 'Moha504',
    realName: 'Moha',
    imageUrl: 'https://example.com/avatar.png',
    country: 'Egypt',
    playCount: 189513,
    registeredAt: new Date('2020-01-01T00:00:00Z'),
    artistCount: 6616,
    albumCount: 13309,
    trackCount: 25952,
  };

  it('builds full profile response with variety and statistics matching fmbot 1:1', () => {
    const response = ProfileBuilders.buildProfileResponse({
      userDisplayName: 'Moha',
      lastFmUser: mockLfmUser,
      user: {
        userId: 1,
        userNameLastFm: 'Moha504',
        discordUserId: BigInt('687636049576722472'),
        userType: UserType.User,
      } as any,
      top10ArtistsScrobbles: 50000,
      friendsCount: 12,
      accentColor: 0xa6006c,
    });

    expect(response.embed).toBeDefined();
    const desc = response.embed.data.description ?? '';
    expect(desc).toContain('## [Moha](https://last.fm/user/Moha504)');
    expect(desc).toContain('**189,513** scrobbles');
    expect(desc).toContain('Since <t:1577836800:D>');
    expect(desc).toContain('**25,952** different tracks');
    expect(desc).toContain('**13,309** different albums');
    expect(desc).toContain('**6,616** different artists');
    expect(desc).toContain('scrobbles per day');
    expect(desc).toContain('Top **10** artists make up **26.4%** of scrobbles');
    expect(response.embed.data.color).toBe(0xa6006c);
    expect(response.componentsV2Container).toBeDefined();
    expect(response.buildComponents().length).toBeGreaterThan(0);
  });

  it('builds profile history response with monthly and yearly entries', () => {
    const response = ProfileBuilders.buildProfileHistoryResponse({
      userDisplayName: 'Moha',
      lastFmUser: mockLfmUser,
      registeredUnix: 1577836800,
      user: {
        userId: 1,
        userNameLastFm: 'Moha504',
        discordUserId: BigInt('687636049576722472'),
      } as any,
      accentColor: 0xa6006c,
      months: [
        { monthName: 'September 2026', playCount: 767, timeString: '1d 20h' },
        { monthName: 'August 2026', playCount: 5718, timeString: '13d 21h' },
      ],
      years: [
        { year: '2026', playCount: 33008, timeString: '80d 5h' },
      ],
    });

    expect(response.embed).toBeDefined();
    const desc = response.embed.data.description ?? '';
    expect(desc).toContain("## [Moha](https://last.fm/user/Moha504)'s history");
    expect(desc).toContain('**Last months**');
    expect(desc).toContain('**`September 2026`** - **767** plays - **1d 20h**');
    expect(desc).toContain('**All years**');
    expect(desc).toContain('**`2026`** - **33,008** plays - **80d 5h**');
    expect(response.componentsV2Container).toBeDefined();
  });

  it('leaves accent color undefined/blank when no custom color is set', () => {
    const response = ProfileBuilders.buildProfileResponse({
      userDisplayName: 'Moha',
      lastFmUser: mockLfmUser,
      accentColor: undefined,
    });

    expect(response.embed.data.color).toBeUndefined();
    const containerJson = (response.componentsV2Container as any).toJSON();
    expect(containerJson.accent_color).toBeUndefined();
  });

  it('formats " All" years entry matching fmbot 1:1', () => {
    const response = ProfileBuilders.buildProfileHistoryResponse({
      userDisplayName: 'Moha',
      lastFmUser: mockLfmUser,
      registeredUnix: 1577836800,
      accentColor: undefined,
      months: [
        { monthName: 'September', playCount: 767, timeString: '1 day, 20 hours' },
      ],
      years: [
        { year: ' All', playCount: 33008, timeString: '80 days, 5 hours' },
        { year: '2026', playCount: 33008, timeString: '80 days, 5 hours' },
      ],
    });

    const desc = response.embed.data.description ?? '';
    expect(desc).toContain('**` All`** - **33,008** plays - **80 days, 5 hours**');
    expect(desc).toContain('**`2026`** - **33,008** plays - **80 days, 5 hours**');
    expect(desc).toContain('**`September`** - **767** plays - **1 day, 20 hours**');
  });
});
