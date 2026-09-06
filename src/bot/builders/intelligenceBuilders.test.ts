import { describe, it, expect } from 'vitest';
import { IntelligenceBuilders } from './intelligenceBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('IntelligenceBuilders', () => {
  describe('buildListeningGapsResponse', () => {
    it('builds a paginated container for artist gaps', () => {
      const response = IntelligenceBuilders.buildListeningGapsResponse({
        displayName: 'Moha',
        userNameLastFm: 'moha_lfm',
        entityType: 'artist',
        items: [
          {
            name: 'Radiohead',
            resumeDate: new Date('2024-05-01T00:00:00Z'),
            prevPlayed: new Date('2023-01-01T00:00:00Z'),
            gapDays: 486,
            totalPlays: 1250,
          },
        ],
        accentColor: 0xff0000,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('builds a fallback container when items list is empty', () => {
      const response = IntelligenceBuilders.buildListeningGapsResponse({
        displayName: 'Moha',
        userNameLastFm: 'moha_lfm',
        entityType: 'album',
        items: [],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildDiscoveriesResponse', () => {
    it('builds a container for discoveries', () => {
      const response = IntelligenceBuilders.buildDiscoveriesResponse({
        displayName: 'Moha',
        userNameLastFm: 'moha_lfm',
        periodDescription: 'the past 90 days',
        items: [
          {
            artistName: 'Fontaines D.C.',
            firstPlay: new Date('2024-02-15T00:00:00Z'),
            playcount: 142,
          },
        ],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('builds a fallback container when no discoveries found', () => {
      const response = IntelligenceBuilders.buildDiscoveriesResponse({
        displayName: 'Moha',
        userNameLastFm: 'moha_lfm',
        periodDescription: 'the past 90 days',
        items: [],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildIcebergResponse', () => {
    it('builds a multi-tier iceberg container', () => {
      const response = IntelligenceBuilders.buildIcebergResponse({
        data: {
          displayName: 'Moha',
          userNameLastFm: 'moha_lfm',
          timePeriodDescription: 'All time',
          totalArtists: 5,
          tiers: [
            { tierNumber: 1, name: 'The Tip', emoji: '🏔️', description: 'Mainstream', artists: [{ name: 'Radiohead', playcount: 500, popularity: 85 }] },
            { tierNumber: 2, name: 'Waterline', emoji: '🌊', description: 'Popular', artists: [{ name: 'Slowdive', playcount: 300, popularity: 65 }] },
            { tierNumber: 3, name: 'The Depths', emoji: '⚓', description: 'Indie', artists: [{ name: 'Sweet Trip', playcount: 200, popularity: 45 }] },
            { tierNumber: 4, name: 'Twilight Zone', emoji: '🪨', description: 'Underground', artists: [{ name: 'Parannoul', playcount: 150, popularity: 25 }] },
            { tierNumber: 5, name: 'The Abyss', emoji: '🐙', description: 'Obscure', artists: [{ name: 'Panchiko', playcount: 100, popularity: 15 }] },
          ],
        },
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildAffinityResponse', () => {
    it('builds a server soulmates container', () => {
      const response = IntelligenceBuilders.buildAffinityResponse({
        data: {
          userDisplayName: 'Moha',
          userNameLastFm: 'moha_lfm',
          guildName: 'Indie Haven',
          totalGuildUsers: 10,
          neighbors: [
            {
              userId: 2,
              discordUserId: '222222222222222222',
              userNameLastFm: 'charlie_lfm',
              totalPercentage: 84,
              artistPercentage: 78,
              genrePercentage: 92,
              countryPercentage: 85,
              sharedArtists: ['Radiohead', 'Slowdive', 'The Cure'],
            },
          ],
        },
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildLovedTracksResponse', () => {
    it('builds loved tracks container', () => {
      const response = IntelligenceBuilders.buildLovedTracksResponse({
        displayName: 'Moha',
        userNameLastFm: 'moha_lfm',
        tracks: [
          { name: 'Creep', artistName: 'Radiohead', playcount: 1, url: 'https://last.fm/music/Radiohead/_/Creep' },
        ],
        total: 1,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildLoveSuccessResponse & buildScrobbleSuccessResponse', () => {
    it('builds love success response', () => {
      const response = IntelligenceBuilders.buildLoveSuccessResponse('Radiohead', 'Creep', true);
      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('builds scrobble success response', () => {
      const response = IntelligenceBuilders.buildScrobbleSuccessResponse('Radiohead', 'Creep', 'Pablo Honey');
      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });
});
