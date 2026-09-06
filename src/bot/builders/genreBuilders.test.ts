import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GenreBuilders } from './genreBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('GenreBuilders', () => {
  describe('buildTopGenresResponse', () => {
    it('handles empty genres gracefully', () => {
      const response = GenreBuilders.buildTopGenresResponse({
        displayName: 'TestUser',
        genres: [],
        periodDescription: 'overall',
        pageIndex: 0,
        cacheKey: 'test_key',
        callerDiscordUserId: '123456789',
      });

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('formats populated top genres list with artist contributors', () => {
      const genres = [
        {
          genreName: 'indie rock',
          userPlaycount: 1420,
          topArtists: ['Arctic Monkeys', 'The Strokes'],
        },
        {
          genreName: 'shoegaze',
          userPlaycount: 890,
          topArtists: ['Slowdive'],
        },
      ];

      const response = GenreBuilders.buildTopGenresResponse({
        displayName: 'Alice',
        genres,
        periodDescription: 'weekly',
        pageIndex: 0,
        cacheKey: 'top_genres_alice',
        callerDiscordUserId: '987654321',
        accentColor: 0x3d5ef2,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('creates pagination buttons when total items exceed page size', () => {
      const genres = Array.from({ length: 25 }, (_, i) => ({
        genreName: `Genre ${i + 1}`,
        userPlaycount: 100 - i,
        topArtists: [],
      }));

      const response = GenreBuilders.buildTopGenresResponse({
        displayName: 'Bob',
        genres,
        periodDescription: 'all-time',
        pageIndex: 0,
        pageSize: 10,
        cacheKey: 'top_genres_bob',
        callerDiscordUserId: '111222333',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildGenreArtistsResponse', () => {
    it('handles empty artists list', () => {
      const response = GenreBuilders.buildGenreArtistsResponse({
        genreName: 'post-punk',
        artists: [],
        isServerView: false,
        targetName: 'Charlie',
        pageIndex: 0,
        cacheKey: 'genre_artists_post_punk',
        callerDiscordUserId: '111',
      });

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('formats user and server views properly', () => {
      const artists = [
        { artistName: 'Joy Division', userPlaycount: 500 },
        { artistName: 'The Cure', userPlaycount: 350 },
      ];

      const userResponse = GenreBuilders.buildGenreArtistsResponse({
        genreName: 'post-punk',
        artists,
        isServerView: false,
        targetName: 'Dave',
        pageIndex: 0,
        cacheKey: 'post_punk_user',
        callerDiscordUserId: '222',
        guildId: '999',
      });

      expect(userResponse.commandResponse).toBe(CommandResponse.Ok);
      expect(userResponse.isComponentsV2).toBe(true);

      const serverResponse = GenreBuilders.buildGenreArtistsResponse({
        genreName: 'post-punk',
        artists,
        isServerView: true,
        targetName: 'Cool Server',
        pageIndex: 0,
        cacheKey: 'post_punk_server',
        callerDiscordUserId: '222',
        guildId: '999',
      });

      expect(serverResponse.commandResponse).toBe(CommandResponse.Ok);
      expect(serverResponse.isComponentsV2).toBe(true);
    });
  });

  describe('buildWhoKnowsGenreResponse', () => {
    it('formats leaderboard of server listeners for a genre', () => {
      const items = [
        {
          userId: 1,
          discordUserId: '1001',
          userNameLastFm: 'music_lover',
          playcount: 1200,
        },
        {
          userId: 2,
          discordUserId: '1002',
          userNameLastFm: 'shoegazer',
          playcount: 950,
        },
      ];

      const response = GenreBuilders.buildWhoKnowsGenreResponse({
        genreName: 'dream pop',
        serverName: 'Music Hub',
        items,
        pageIndex: 0,
        cacheKey: 'wkg_dream_pop',
        callerDiscordUserId: '1001',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildArtistGenresResponse', () => {
    it('formats artist tag list', () => {
      const response = GenreBuilders.buildArtistGenresResponse('Radiohead', ['alternative rock', 'art rock', 'electronic']);
      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('handles empty tag list', () => {
      const response = GenreBuilders.buildArtistGenresResponse('Unknown Artist', []);
      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });
});
