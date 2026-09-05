import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
  parseGuildRankingSettings,
  OrderType,
  GuildRankingItem,
} from '@bot/services/guildRankingService';
import {
  ServerBuilders,
  getBillboardMovementBadge,
  formatRankingItemLine,
  BillboardEmotes,
} from './serverBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';

describe('ServerBuilders & GuildRankingService', () => {
  describe('parseGuildRankingSettings', () => {
    it('defaults to weekly and listeners order when options are empty', () => {
      const settings = parseGuildRankingSettings('');
      expect(settings.chartTimePeriod).toBe('weekly');
      expect(settings.orderType).toBe(OrderType.Listeners);
      expect(settings.amountOfDays).toBe(7);
      expect(settings.billboardStartDateTime).not.toBeNull();
      expect(settings.newSearchValue).toBeNull();
    });

    it('detects plays order keywords: p, pc, playcount, plays, scrobbles', () => {
      expect(parseGuildRankingSettings('plays').orderType).toBe(OrderType.Playcount);
      expect(parseGuildRankingSettings('p').orderType).toBe(OrderType.Playcount);
      expect(parseGuildRankingSettings('pc').orderType).toBe(OrderType.Playcount);
      expect(parseGuildRankingSettings('scrobbles').orderType).toBe(OrderType.Playcount);
    });

    it('detects listeners order keywords: l, lc, listeners, listenercount', () => {
      expect(parseGuildRankingSettings('listeners').orderType).toBe(OrderType.Listeners);
      expect(parseGuildRankingSettings('lc').orderType).toBe(OrderType.Listeners);
    });

    it('handles alltime keyword and disables billboard comparison', () => {
      const settings = parseGuildRankingSettings('alltime');
      expect(settings.chartTimePeriod).toBe('alltime');
      expect(settings.timeDescription).toBe('all-time');
      expect(settings.billboardStartDateTime).toBeNull();
    });

    it('handles monthly keyword and sets 30 days window', () => {
      const settings = parseGuildRankingSettings('monthly');
      expect(settings.chartTimePeriod).toBe('monthly');
      expect(settings.amountOfDays).toBe(30);
      expect(settings.billboardStartDateTime).not.toBeNull();
    });

    it('extracts artist filter from leftover tokens', () => {
      const settings = parseGuildRankingSettings('monthly plays Radiohead');
      expect(settings.chartTimePeriod).toBe('monthly');
      expect(settings.orderType).toBe(OrderType.Playcount);
      expect(settings.newSearchValue).toBe('Radiohead');
    });

    it('parses specific month and year', () => {
      const settings = parseGuildRankingSettings('march 2024');
      expect(settings.chartTimePeriod).toBe('March 2024');
      expect(settings.startDateTime.getUTCFullYear()).toBe(2024);
      expect(settings.startDateTime.getUTCMonth()).toBe(2); // 0-indexed March = 2
      expect(settings.billboardStartDateTime).not.toBeNull();
    });
  });

  describe('getBillboardMovementBadge', () => {
    it('returns new badge when old position is null', () => {
      expect(getBillboardMovementBadge(0, null)).toBe(BillboardEmotes.new);
    });

    it('returns same position badge when old position matches new position', () => {
      expect(getBillboardMovementBadge(4, 4)).toBe(BillboardEmotes.samePosition);
    });

    it('returns one to five up when position improved by 1 to 4', () => {
      // Improved: old was 5, now is 2 (higher on chart)
      expect(getBillboardMovementBadge(2, 5)).toBe(BillboardEmotes.oneToFiveUp);
    });

    it('returns five or more up when position improved by >= 5', () => {
      // Improved: old was 10, now is 2
      expect(getBillboardMovementBadge(2, 10)).toBe(BillboardEmotes.fiveOrMoreUp);
    });

    it('returns one to five down when position dropped by 1 to 4', () => {
      // Dropped: old was 2, now is 5
      expect(getBillboardMovementBadge(5, 2)).toBe(BillboardEmotes.oneToFiveDown);
    });

    it('returns five or more down when position dropped by >= 5', () => {
      // Dropped: old was 1, now is 9
      expect(getBillboardMovementBadge(9, 1)).toBe(BillboardEmotes.fiveOrMoreDown);
    });
  });

  describe('formatRankingItemLine', () => {
    const artistItem: GuildRankingItem = {
      name: 'Radiohead',
      listenerCount: 14,
      totalPlaycount: 245,
    };

    it('formats artist line in Listeners order', () => {
      const line = formatRankingItemLine('artists', artistItem, OrderType.Listeners, BillboardEmotes.samePosition);
      expect(line).toBe(`${BillboardEmotes.samePosition} \`14\` · **Radiohead** · *245 plays*`);
    });

    it('formats artist line in Plays order', () => {
      const line = formatRankingItemLine('artists', artistItem, OrderType.Playcount, BillboardEmotes.oneToFiveUp);
      expect(line).toBe(`${BillboardEmotes.oneToFiveUp} \`245\` · **Radiohead** · *14 listeners*`);
    });

    const albumItem: GuildRankingItem = {
      name: 'OK Computer',
      secondaryName: 'Radiohead',
      listenerCount: 8,
      totalPlaycount: 120,
    };

    it('formats album line with artist prefix when no artist filter is active', () => {
      const line = formatRankingItemLine('albums', albumItem, OrderType.Listeners, BillboardEmotes.new);
      expect(line).toBe(`${BillboardEmotes.new} \`8\` · **Radiohead** - **OK Computer** · *120 plays*`);
    });

    it('formats album line without artist prefix when artist filter is active', () => {
      const line = formatRankingItemLine('albums', albumItem, OrderType.Listeners, null, 'Radiohead');
      expect(line).toBe('`8` · **OK Computer** · *120 plays*');
    });

    const trackItem: GuildRankingItem = {
      name: 'Paranoid Android',
      secondaryName: 'Radiohead',
      listenerCount: 5,
      totalPlaycount: 65,
    };

    it('formats track line', () => {
      const line = formatRankingItemLine('tracks', trackItem, OrderType.Listeners, BillboardEmotes.samePosition);
      expect(line).toBe(`${BillboardEmotes.samePosition} \`5\` · **Radiohead** - **Paranoid Android** · *65 plays*`);
    });

    const genreItem: GuildRankingItem = {
      name: 'art rock',
      listenerCount: 12,
      totalPlaycount: 430,
    };

    it('formats genre line with title case', () => {
      const line = formatRankingItemLine('genres', genreItem, OrderType.Listeners, BillboardEmotes.new);
      expect(line).toBe(`${BillboardEmotes.new} \`12\` · **Art Rock** - *430 plays*`);
    });
  });

  describe('buildServerLeaderboardResponse', () => {
    it('builds components v2 container with 12 items per page and accent color', () => {
      const items: GuildRankingItem[] = Array.from({ length: 15 }, (_, i) => ({
        name: `Artist ${i + 1}`,
        listenerCount: 20 - i,
        totalPlaycount: (20 - i) * 10,
      }));

      const settings = parseGuildRankingSettings('weekly');
      const response = ServerBuilders.buildServerLeaderboardResponse({
        type: 'artists',
        serverName: 'Music Haven',
        items,
        previousItems: items,
        settings,
        pageIndex: 0,
        cacheKey: 'testkey1',
        callerDiscordUserId: '123456789',
        accentColor: 0x5865F2,
      });

      expect(response.isComponentsV2).toBe(true);
      const payload = response.toMessagePayload();
      expect(payload.components).toBeDefined();
      expect(payload.embeds).toBeUndefined();

      const containerJson = (response.componentsV2Container as any).toJSON();
      expect(containerJson.accent_color).toBe(0x5865F2);
    });

    it('leaves accent color blank/undefined when neither guild nor user accent color is set', () => {
      const items: GuildRankingItem[] = [
        { name: 'Radiohead', listenerCount: 5, totalPlaycount: 50 },
      ];

      const settings = parseGuildRankingSettings('weekly');
      const response = ServerBuilders.buildServerLeaderboardResponse({
        type: 'artists',
        serverName: 'Music Haven',
        items,
        previousItems: null,
        settings,
        pageIndex: 0,
        cacheKey: 'testkey2',
        callerDiscordUserId: '123456789',
        accentColor: undefined,
      });

      const containerJson = (response.componentsV2Container as any).toJSON();
      expect(containerJson.accent_color).toBeUndefined();
    });

    it('handles empty results with warning container', () => {
      const settings = parseGuildRankingSettings('weekly');
      const response = ServerBuilders.buildServerLeaderboardResponse({
        type: 'artists',
        serverName: 'Empty Server',
        items: [],
        previousItems: null,
        settings,
        pageIndex: 0,
        cacheKey: 'testkey3',
        callerDiscordUserId: '123456789',
      });

      expect(response.isComponentsV2).toBe(true);
      const containerJson = (response.componentsV2Container as any).toJSON();
      expect(containerJson.accent_color).toBe(DiscordConstants.WarningColorOrange);
    });
  });
});
