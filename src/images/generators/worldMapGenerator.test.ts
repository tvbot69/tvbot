import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { WorldMapGenerator, CountryChartTheme } from './worldMapGenerator';

describe('WorldMapGenerator', () => {
  describe('theme resolution', () => {
    it('resolves theme names correctly', () => {
      expect(WorldMapGenerator.getThemeFromName('dark')).toBe(CountryChartTheme.Dark);
      expect(WorldMapGenerator.getThemeFromName('light')).toBe(CountryChartTheme.Light);
      expect(WorldMapGenerator.getThemeFromName('ocean')).toBe(CountryChartTheme.Ocean);
      expect(WorldMapGenerator.getThemeFromName('synthwave')).toBe(CountryChartTheme.Synthwave);
      expect(WorldMapGenerator.getThemeFromName('sunset')).toBe(CountryChartTheme.Sunset);
      expect(WorldMapGenerator.getThemeFromName('forest')).toBe(CountryChartTheme.Forest);
      expect(WorldMapGenerator.getThemeFromName(undefined)).toBe(CountryChartTheme.Dark);
      expect(WorldMapGenerator.getThemeFromName('unknown')).toBe(CountryChartTheme.Dark);
    });

    it('returns human-readable theme names', () => {
      expect(WorldMapGenerator.getThemeName(CountryChartTheme.Dark)).toBe('Dark');
      expect(WorldMapGenerator.getThemeName(CountryChartTheme.Ocean)).toBe('Ocean');
      expect(WorldMapGenerator.getThemeName(CountryChartTheme.Sunset)).toBe('Sunset');
    });
  });

  describe('generateWorldMap', () => {
    it('generates a world map SVG and calls puppeteer screenshot', async () => {
      const mockPuppeteerService: any = {
        screenshotHtml: async (html: string, width: number, height: number) => {
          expect(width).toBe(2754);
          expect(height).toBe(1398);
          expect(html).toContain('Artists per country');
          expect(html).toContain('.us{fill:');
          expect(html).toContain('.jp{fill:');
          return Buffer.from('mock_map_png');
        },
      };

      const generator = new WorldMapGenerator(mockPuppeteerService);
      const countries = [
        { countryName: 'United States', countryCode: 'US', playcount: 1000, artistCount: 50 },
        { countryName: 'Japan', countryCode: 'JP', playcount: 400, artistCount: 20 },
      ];

      const buf = await generator.generateWorldMap(countries, CountryChartTheme.Dark);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.toString()).toBe('mock_map_png');
    });
  });
});
