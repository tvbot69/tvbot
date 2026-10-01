import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ComponentType } from 'discord.js';
import { CountryBuilders } from '@bot/builders/library/countryBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { CountryChartTheme } from '@images/generators/worldMapGenerator';
import type { WhoKnowsCountryItem } from '@bot/services/library/countryService';

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

    /*
     * The footer is the only place the card counts people, and it counted them
     * with a hardcoded plural: a guild with exactly one listener was told
     * "1 listeners". `whoKnowsBuilders` gets this right on the same quantity
     * ("1 listener - 263 plays" against "2 listeners - 273 plays"), and the
     * per-row playcount two lines above this footer already made the
     * singular/plural decision - so the card contradicted itself about the same
     * list. Asserted from both ends, because the two directions are opposites
     * and a fix that broke the plural would be a new bug of its own.
     */
    describe('the listener count in the footer', () => {
      interface Cv2Component {
        type: number;
        content?: string;
      }

      /** The serialised tree. Serialising is part of what is under test. */
      const texts = (response: ReturnType<typeof CountryBuilders.buildWhoKnowsCountryResponse>): string[] => {
        const json = response.componentsV2Container?.toJSON() as
          | { components?: Cv2Component[] }
          | undefined;
        return (json?.components ?? [])
          .filter((c) => c.type === ComponentType.TextDisplay)
          .map((c) => c.content ?? '');
      };

      const footer = (rows: WhoKnowsCountryItem[]) =>
        texts(
          CountryBuilders.buildWhoKnowsCountryResponse({
            country: { Name: 'Iceland', Code: 'IS', Emoji: '🇮🇸' },
            serverName: 'Music Hub',
            items: rows,
            pageIndex: 0,
            cacheKey: 'wkc_is',
            callerDiscordUserId: '555',
          }),
        ).slice(-1)[0] ?? '';

      const listener = (i: number, playcount = 10): WhoKnowsCountryItem => ({
        userId: i,
        discordUserId: `100${i}`,
        userNameLastFm: `user_${i}`,
        playcount,
      });

      it('says "1 listener" for a guild with exactly one', () => {
        expect(footer([listener(1)])).toContain('1 listener ·');
        expect(footer([listener(1)])).not.toContain('1 listeners');
      });

      it('still says "listeners" for two or more', () => {
        expect(footer([listener(1), listener(2)])).toContain('2 listeners ·');
      });

      it('pluralises the singular for the row too, so the card agrees with itself', () => {
        // The row label is decided two lines above the footer and was already
        // correct; asserting both together is what stops them drifting again.
        expect(texts(
          CountryBuilders.buildWhoKnowsCountryResponse({
            country: { Name: 'Iceland', Code: 'IS', Emoji: '🇮🇸' },
            serverName: 'Music Hub',
            items: [listener(1, 1)],
            pageIndex: 0,
            cacheKey: 'wkc_is',
            callerDiscordUserId: '555',
          }),
        ).join('\n')).toContain('1 play*');
      });

      it('says the scrobble total beside it, which was never the broken half', () => {
        expect(footer([listener(1), listener(2)])).toContain('20 total scrobbles');
      });
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
