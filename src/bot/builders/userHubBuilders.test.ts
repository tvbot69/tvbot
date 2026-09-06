import { describe, it, expect } from 'vitest';
import { UserHubBuilders } from './userHubBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';

describe('UserHubBuilders', () => {
  describe('buildJudgeResponse', () => {
    it('creates container with roast mode and action buttons', () => {
      const response = UserHubBuilders.buildJudgeResponse({
        result: {
          mode: 'roast',
          userNameLastFm: 'tester',
          discordUserId: '1001',
          rating: '3.4 / 10',
          headline: 'Addicted to Radiohead',
          critique: 'Step outside and touch vinyl.',
          topArtists: ['Radiohead', 'The Smiths'],
          topTracks: ['Creep by Radiohead'],
          period: TimePeriod.Quarterly,
        },
        displayName: 'Test User',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('creates container with compliment mode', () => {
      const response = UserHubBuilders.buildJudgeResponse({
        result: {
          mode: 'compliment',
          userNameLastFm: 'audiophile',
          discordUserId: '1002',
          rating: '9.2 / 10',
          headline: 'Impeccable Taste',
          critique: 'Certified connoisseur.',
          topArtists: ['Aphex Twin'],
          topTracks: [],
          period: TimePeriod.Quarterly,
        },
        displayName: 'Audiophile',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildBotScrobblingResponse', () => {
    it('creates container with status and action buttons', () => {
      const response = UserHubBuilders.buildBotScrobblingResponse({
        optedIn: true,
        nowPlaying: {
          guildId: 'g1',
          voiceChannelId: 'vc1',
          title: 'Karma Police',
          artist: 'Radiohead',
          durationMs: 260000,
          startedAt: Date.now(),
        },
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildBotTrackResponse', () => {
    it('creates container with active track', () => {
      const response = UserHubBuilders.buildBotTrackResponse({
        track: {
          guildId: 'g1',
          voiceChannelId: 'vc1',
          title: 'Karma Police',
          artist: 'Radiohead',
          durationMs: 260000,
          startedAt: Date.now(),
        },
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildFeaturedResponse', () => {
    it('creates container with featured listener and album artwork', () => {
      const response = UserHubBuilders.buildFeaturedResponse({
        featured: {
          userId: 1,
          discordUserId: '1001',
          userNameLastFm: 'featured_fan',
          artistName: 'Radiohead',
          albumName: 'OK Computer',
          playcount: 120,
          imageUrl: 'https://lastfm.freetls.fastly.net/okcomputer.jpg',
          featuredAt: new Date(),
        },
        prefix: '.',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildFeaturedLogResponse', () => {
    it('creates container with log entries', () => {
      const response = UserHubBuilders.buildFeaturedLogResponse({
        log: [
          {
            userId: 1,
            discordUserId: '1001',
            userNameLastFm: 'fan',
            artistName: 'Radiohead',
            albumName: 'Kid A',
            playcount: 85,
            featuredAt: new Date(),
          },
        ],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildShortcutsResponse', () => {
    it('creates container with user shortcut mappings', () => {
      const response = UserHubBuilders.buildShortcutsResponse({
        displayName: 'Moha',
        shortcuts: [
          { name: 'mytop', command: 'top artists 1m' },
        ],
        prefix: '.',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildRateYourMusicResponse', () => {
    it('creates container with RYM search link', () => {
      const response = UserHubBuilders.buildRateYourMusicResponse({
        query: 'Radiohead OK Computer',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildYoutubeResponse', () => {
    it('creates container with YouTube search link', () => {
      const response = UserHubBuilders.buildYoutubeResponse({
        query: 'Radiohead Creep',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });
});
