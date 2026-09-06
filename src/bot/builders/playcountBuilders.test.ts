import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PlaycountBuilders } from './playcountBuilders';
import { SettingService } from '@bot/services/settingService';

describe('PlaycountBuilders and SettingService', () => {
  describe('SettingService.getGoalAmount', () => {
    it('calculates the next milestone breakpoint when no goal is passed', () => {
      expect(SettingService.getGoalAmount(undefined, 420)).toBe(500);
      expect(SettingService.getGoalAmount(undefined, 9500)).toBe(10000);
      expect(SettingService.getGoalAmount(undefined, 85000)).toBe(100000);
    });

    it('parses k multiplier shorthand correctly', () => {
      expect(SettingService.getGoalAmount('50k', 10000)).toBe(50000);
      expect(SettingService.getGoalAmount('100K', 10000)).toBe(100000);
    });

    it('parses raw numbers correctly', () => {
      expect(SettingService.getGoalAmount('25000', 10000)).toBe(25000);
    });
  });

  describe('SettingService.getMilestoneAmount', () => {
    it('picks previous milestone breakpoint if no amount specified', () => {
      const res = SettingService.getMilestoneAmount(undefined, 5600);
      expect(res.amount).toBe(5000);
      expect(res.isRandom).toBe(false);
    });

    it('supports random milestone generation with rnd/random keyword', () => {
      const res = SettingService.getMilestoneAmount('random', 5000);
      expect(res.isRandom).toBe(true);
      expect(res.amount).toBeGreaterThanOrEqual(1);
      expect(res.amount).toBeLessThanOrEqual(5000);
    });

    it('supports custom amount or shorthand', () => {
      const res = SettingService.getMilestoneAmount('10k', 50000);
      expect(res.amount).toBe(10000);
      expect(res.isRandom).toBe(false);
    });
  });

  describe('PlaycountBuilders embed outputs', () => {
    it('builds artist plays response with week/month info', () => {
      const response = PlaycountBuilders.buildArtistPlaysResponse(
        'User123',
        'Radiohead',
        1500,
        25,
        100,
      );
      expect(response.content).toBeDefined();
      expect(response.content).toContain('User123');
      expect(response.content).toContain('**1500** plays');
      expect(response.content).toContain('25 plays last week');
      expect(response.content).toContain('100 plays last month');
    });

    it('builds album plays response', () => {
      const response = PlaycountBuilders.buildAlbumPlaysResponse(
        'User123',
        'Radiohead',
        'OK Computer',
        350,
        10,
        40,
      );
      expect(response.content).toBeDefined();
      expect(response.content).toContain('User123');
      expect(response.content).toContain('**350** plays');
      expect(response.content).toContain('OK Computer');
    });

    it('builds track plays response', () => {
      const response = PlaycountBuilders.buildTrackPlaysResponse(
        'User123',
        'Radiohead',
        'Paranoid Android',
        120,
        5,
        15,
      );
      expect(response.content).toBeDefined();
      expect(response.content).toContain('User123');
      expect(response.content).toContain('**120** plays');
      expect(response.content).toContain('Paranoid Android');
    });

    it('builds plays response for all-time and period', () => {
      const allTime = PlaycountBuilders.buildPlaysResponse('User123', 50000, true, 'Alltime');
      expect(allTime.content).toContain('`50000` total scrobbles');

      const weekly = PlaycountBuilders.buildPlaysResponse('User123', 250, false, 'Weekly');
      expect(weekly.content).toContain('`250` scrobbles in the Weekly');
    });

    it('builds pace response', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const registeredSec = nowSec - 365 * 86400; // 1 year ago
      const response = PlaycountBuilders.buildPaceResponse(
        '<@123>',
        'User123',
        false,
        50000,
        25000,
        25000,
        registeredSec,
        true,
      );
      expect(response.content).toContain('50,000');
      expect(response.content).toContain('per day');
    });

    it('builds milestone response with reroll button if random', () => {
      const response = PlaycountBuilders.buildMilestoneResponse(
        'User123',
        'user_lastfm',
        10000,
        'Radiohead',
        'OK Computer',
        'Karma Police',
        new Date('2026-01-01T00:00:00Z'),
        'https://example.com/cover.png',
        0xa6006c,
        true,
        1,
        1,
      );
      const json = response.embed.toJSON();
      expect(json.title).toBe('10000th scrobble from User123');
      expect(json.description).toContain('### [Karma Police]');
      expect(json.description).toContain('**Radiohead** • *OK Computer*');
      expect(json.thumbnail?.url).toBe('https://example.com/cover.png');
      expect(json.color).toBe(0xa6006c);
      expect(response.buildComponents().length).toBeGreaterThan(0);
    });

    it('builds discovery date response', () => {
      const response = PlaycountBuilders.buildDiscoveryDateResponse(
        'User123',
        false,
        'Radiohead',
        'Kid A',
        'Everything In Its Right Place',
        new Date('2024-01-01T12:00:00Z'),
        new Date('2024-02-01T12:00:00Z'),
        new Date('2024-03-01T12:00:00Z'),
        true,
      );
      const json = response.embed.toJSON();
      expect(json.author?.name).toContain('Discovery dates for User123');
      expect(json.description).toContain('Radiohead');
      expect(json.description).toContain('Kid A');
      expect(json.description).toContain('Everything In Its Right Place');
    });

    it('builds last listened response', () => {
      const response = PlaycountBuilders.buildLastListenedDateResponse(
        'User123',
        false,
        'Radiohead',
        'Kid A',
        'Everything In Its Right Place',
        new Date('2026-08-01T12:00:00Z'),
        new Date('2026-08-02T12:00:00Z'),
        new Date('2026-08-03T12:00:00Z'),
        true,
      );
      const json = response.embed.toJSON();
      expect(json.author?.name).toContain('Last listened dates for User123');
      expect(json.description).toContain('Radiohead');
      expect(json.description).toContain('Kid A');
      expect(json.description).toContain('Everything In Its Right Place');
    });
  });

  describe('Text Command alias definitions', () => {
    it('ensures ap is exclusive to artistplays and not autoplay', async () => {
      const { PlaycountCommands } = await import('@bot/textCommands/lastfm/playcountCommands');
      const { MusicCommands } = await import('@bot/textCommands/music/musicCommands');
      const { FootballCommands } = await import('@bot/textCommands/football/footballCommands');

      // Check playcount commands define ap and m
      const pc = new PlaycountCommands(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const apDef = pc.commands.find((c) => c.name === 'artistplays');
      expect(apDef?.aliases).toContain('ap');

      const mDef = pc.commands.find((c) => c.name === 'milestone');
      expect(mDef?.aliases).toContain('m');
      expect(mDef?.aliases).toContain('ms');

      // Check music commands no longer hijack ap
      const mc = new MusicCommands({} as any, {} as any);
      const autoDef = mc.commands.find((c) => c.name === 'autoplay');
      expect(autoDef?.aliases).not.toContain('ap');
      expect(autoDef?.aliases).toContain('auto');

      // Check football commands no longer hijack m
      const fc = new FootballCommands({} as any);
      const matchDef = fc.commands.find((c) => c.name === 'matches');
      expect(matchDef?.aliases).not.toContain('m');
    });

    it('verifies Phase 4 command aliases are defined in PlaycountCommands', async () => {
      const { PlaycountCommands } = await import('@bot/textCommands/lastfm/playcountCommands');
      const pc = new PlaycountCommands(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const receiptDef = pc.commands.find((c) => c.name === 'receipt');
      expect(receiptDef?.aliases).toContain('rcpt');
      expect(receiptDef?.aliases).toContain('receiptify');

      const apcDef = pc.commands.find((c) => c.name === 'artistpace');
      expect(apcDef?.aliases).toContain('apc');

      const yrDef = pc.commands.find((c) => c.name === 'year');
      expect(yrDef?.aliases).toContain('yr');

      const lbDef = pc.commands.find((c) => c.name === 'playleaderboard');
      expect(lbDef?.aliases).toContain('sblb');

      const tlbDef = pc.commands.find((c) => c.name === 'timeleaderboard');
      expect(tlbDef?.aliases).toContain('tlb');
    });
  });

  describe('Phase 4 Builders', () => {
    it('builds artist pace projection response', () => {
      const resp = PlaycountBuilders.buildArtistPaceResponse({
        callerMention: '<@123>',
        displayName: 'Alice',
        isDifferentUser: false,
        artistName: 'Radiohead',
        goalAmount: 1000,
        allTimePlays: 750,
        periodPlays: 50,
        days: 30,
      });

      expect(resp.content).toContain('Radiohead');
      expect(resp.content).toContain('1,000');
      expect(resp.content).toContain('estimate');
    });

    it('builds year overview response container', () => {
      const resp = PlaycountBuilders.buildYearOverviewResponse({
        displayName: 'Alice',
        userNameLastFm: 'alice_fm',
        yearData: {
          year: 2025,
          totalPlays: 15420,
          totalArtists: 450,
          topArtists: [{ name: 'Radiohead', playcount: 1200 }],
          topTracks: [{ trackName: 'Creep', artistName: 'Radiohead', playcount: 150 }],
          topAlbums: [{ albumName: 'OK Computer', artistName: 'Radiohead', playcount: 600 }],
          topGenres: [{ name: 'Rock', playcount: 3500 }],
          topCountries: [{ countryName: 'United Kingdom', countryCode: 'GB', playcount: 5000 }],
          monthlyPlays: [1200, 1100, 1300, 1400, 1500, 1200, 1100, 1300, 1200, 1400, 1300, 1420],
          previousTotalPlays: 12000,
        },
      });

      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });

    it('builds server leaderboard response container', () => {
      const resp = PlaycountBuilders.buildLeaderboardResponse({
        guildName: 'Music Club',
        title: 'Scrobbles Leaderboard',
        unit: 'plays',
        entries: [
          { discordUserId: '111', userNameLastFm: 'alice', displayName: 'Alice', value: 50000 },
          { discordUserId: '222', userNameLastFm: 'bob', displayName: 'Bob', value: 35000 },
          { discordUserId: '333', userNameLastFm: 'charlie', displayName: 'Charlie', value: 20000 },
        ],
      });

      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });
});
