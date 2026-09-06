import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { CountryBuilders } from './countryBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { CountryChartTheme } from '@images/generators/worldMapGenerator';

describe('CountryBuilders', () => {
  describe('buildTopCountriesResponse', () => {
    it('handles empty countries gracefully', () => {
      const response = CountryBuilders.buildTopCountriesResponse({
        displayName: 'TestUser',
        countries: [],
        periodDescription: 'overall',
        pageIndex: 0,
        cacheKey: 'test_key',
        callerDiscordUserId: '123456789',
      });

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('formats populated top countries list with flag emojis and artist counts', () => {
      const countries = [
        {
          countryName: 'United States',
          countryCode: 'US',
          playcount: 3200,
          artistCount: 45,
          artists: [{ name: 'Nirvana', playcount: 800 }],
        },
        {
          countryName: 'United Kingdom',
          countryCode: 'GB',
          playcount: 2400,
          artistCount: 30,
        },
        {
          countryName: 'Japan',
          countryCode: 'JP',
          playcount: 1500,
          artistCount: 15,
        },
      ];

      const response = CountryBuilders.buildTopCountriesResponse({
        displayName: 'Alice',
        countries,
        periodDescription: 'weekly',
        pageIndex: 0,
        cacheKey: 'top_countries_alice',
        callerDiscordUserId: '987654321',
        accentColor: 0x3d5ef2,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('creates pagination buttons and toggle buttons when total items exceed page size', () => {
      const countries = Array.from({ length: 25 }, (_, i) => ({
        countryName: `Country ${i + 1}`,
        countryCode: 'US',
        playcount: 1000 - i * 10,
        artistCount: 5,
      }));

      const response = CountryBuilders.buildTopCountriesResponse({
        displayName: 'Bob',
        countries,
        periodDescription: 'all-time',
        pageIndex: 0,
        pageSize: 10,
        cacheKey: 'top_countries_bob',
        callerDiscordUserId: '111222333',
        guildId: '999888777',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildCountryArtistsResponse', () => {
    it('handles empty artists list', () => {
      const response = CountryBuilders.buildCountryArtistsResponse({
        country: { Name: 'Japan', Code: 'JP', Emoji: '🇯🇵' },
        artists: [],
        isServerView: false,
        targetName: 'Charlie',
        pageIndex: 0,
        cacheKey: 'country_artists_jp',
        callerDiscordUserId: '111',
      });

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('formats user and server views properly with UA easter egg', () => {
      const artists = [
        { name: 'Jinjer', playcount: 650 },
        { name: '1914', playcount: 320 },
      ];

      const response = CountryBuilders.buildCountryArtistsResponse({
        country: { Name: 'Ukraine', Code: 'UA', Emoji: '🇺🇦' },
        artists,
        isServerView: false,
        targetName: 'David',
        pageIndex: 0,
        cacheKey: 'country_artists_ua',
        callerDiscordUserId: '222',
        guildId: '333',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildArtistCountryInfoResponse', () => {
    it('returns not found message when country is undefined', () => {
      const response = CountryBuilders.buildArtistCountryInfoResponse({
        artistName: 'Unknown Artist',
      });

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(response.isComponentsV2).toBe(true);
    });

    it('displays artist country, location, and user plays when found', () => {
      const response = CountryBuilders.buildArtistCountryInfoResponse({
        artistName: 'Radiohead',
        country: { Name: 'United Kingdom', Code: 'GB', Emoji: '🇬🇧' },
        location: 'Abingdon, Oxfordshire',
        spotifyImageUrl: 'https://example.com/radiohead.jpg',
        userPlaycount: 1250,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildWhoKnowsCountryResponse', () => {
    it('handles empty server list', () => {
      const response = CountryBuilders.buildWhoKnowsCountryResponse({
        country: { Name: 'Iceland', Code: 'IS', Emoji: '🇮🇸' },
        serverName: 'Music Hub',
        items: [],
        pageIndex: 0,
        cacheKey: 'wkc_is',
        callerDiscordUserId: '555',
      });

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(response.isComponentsV2).toBe(true);
    });

    it('formats server ranking list', () => {
      const items = [
        { userId: 1, discordUserId: '1001', userNameLastFm: 'user_one', playcount: 1400 },
        { userId: 2, discordUserId: '1002', userNameLastFm: 'user_two', playcount: 850 },
      ];

      const response = CountryBuilders.buildWhoKnowsCountryResponse({
        country: { Name: 'Iceland', Code: 'IS', Emoji: '🇮🇸' },
        serverName: 'Music Hub',
        items,
        pageIndex: 0,
        cacheKey: 'wkc_is',
        callerDiscordUserId: '555',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildCountryChartResponse', () => {
    it('builds V2 container with attachment and theme select menu', () => {
      const fakeBuffer = Buffer.from('fake_image_data');
      const response = CountryBuilders.buildCountryChartResponse({
        displayName: 'Eve',
        periodDescription: 'all-time',
        imageBuffer: fakeBuffer,
        theme: CountryChartTheme.Synthwave,
        callerDiscordUserId: '777',
        cacheKey: 'chart_eve',
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.isComponentsV2).toBe(true);
      expect(response.hasFile()).toBe(true);
      expect(response.fileName).toBe('artist-map.png');
      expect(response.componentsV2Container).toBeDefined();
    });
  });
});
