import { injectable, inject } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import { PuppeteerService } from './puppeteerService';
import type { TopCountryItem } from '@bot/services/countryService';

export enum CountryChartTheme {
  Dark = 1,
  Light = 2,
  Ocean = 3,
  Synthwave = 4,
  Sunset = 5,
  Forest = 6,
}

export interface WorldMapThemePalette {
  svgBackground: string;
  oceanFill: string;
  landFill: string;
  landStroke: string;
  landStrokeWidth: string;
  countryRamp: string[];
  legendBoxFill: string;
  legendBoxBorder: string;
  legendTitleColor: string;
  legendSubtitleColor: string;
  legendSwatchBorder: string;
}

export const WORLD_MAP_THEMES: Record<CountryChartTheme, WorldMapThemePalette> = {
  [CountryChartTheme.Dark]: {
    svgBackground: '#000007',
    oceanFill: '#000007',
    landFill: '#0a0a1a',
    landStroke: '#cfd6e6',
    landStrokeWidth: '1',
    countryRamp: ['#dbeeff', '#8ec6ff', '#5491ff', '#3d5ef2', '#3239d2', '#282c88'],
    legendBoxFill: 'rgba(13, 13, 34, 0.94)',
    legendBoxBorder: '#3a4577',
    legendTitleColor: '#ffffff',
    legendSubtitleColor: '#aab4d4',
    legendSwatchBorder: '#3a4577',
  },
  [CountryChartTheme.Light]: {
    svgBackground: '#e8f1fa',
    oceanFill: '#e8f1fa',
    landFill: '#a7b0be',
    landStroke: '#94a0b0',
    landStrokeWidth: '1',
    countryRamp: ['#062247', '#103760', '#1b4b78', '#256091', '#3074a9', '#3a89c2'],
    legendBoxFill: 'rgba(255, 255, 255, 0.96)',
    legendBoxBorder: '#b8c2cf',
    legendTitleColor: '#1a2733',
    legendSubtitleColor: '#465563',
    legendSwatchBorder: '#7d8a99',
  },
  [CountryChartTheme.Ocean]: {
    svgBackground: '#0c2f4a',
    oceanFill: '#0c2f4a',
    landFill: '#3d2a0f',
    landStroke: '#8a6a3c',
    landStrokeWidth: '1.1',
    countryRamp: ['#bd0026', '#f03b20', '#fd8d3c', '#feb24c', '#fed976', '#ffffb2'],
    legendBoxFill: 'rgba(42, 28, 10, 0.95)',
    legendBoxBorder: '#6a4f28',
    legendTitleColor: '#f7ecd6',
    legendSubtitleColor: '#d8c49a',
    legendSwatchBorder: '#7a5a2c',
  },
  [CountryChartTheme.Synthwave]: {
    svgBackground: '#0c0420',
    oceanFill: '#0c0420',
    landFill: '#190a2e',
    landStroke: '#c83fb0',
    landStrokeWidth: '1.1',
    countryRamp: ['#88fbe8', '#46ccff', '#7b8cff', '#b24ff0', '#bf2a9c', '#a8205e'],
    legendBoxFill: 'rgba(36, 17, 65, 0.95)',
    legendBoxBorder: '#6a36a0',
    legendTitleColor: '#ff9cf0',
    legendSubtitleColor: '#cf9fff',
    legendSwatchBorder: '#ff7be6',
  },
  [CountryChartTheme.Sunset]: {
    svgBackground: '#1a0a1e',
    oceanFill: '#1a0a1e',
    landFill: '#2d132c',
    landStroke: '#ee4540',
    landStrokeWidth: '1.1',
    countryRamp: ['#f9d56e', '#f39233', '#e8505b', '#c72c41', '#801336', '#510a32'],
    legendBoxFill: 'rgba(45, 19, 44, 0.95)',
    legendBoxBorder: '#c72c41',
    legendTitleColor: '#f9d56e',
    legendSubtitleColor: '#f39233',
    legendSwatchBorder: '#ee4540',
  },
  [CountryChartTheme.Forest]: {
    svgBackground: '#0a1a0f',
    oceanFill: '#0a1a0f',
    landFill: '#12291b',
    landStroke: '#2d5a3f',
    landStrokeWidth: '1.1',
    countryRamp: ['#c8e6c9', '#81c784', '#4caf50', '#2e7d32', '#1b5e20', '#0d3813'],
    legendBoxFill: 'rgba(18, 41, 27, 0.95)',
    legendBoxBorder: '#2d5a3f',
    legendTitleColor: '#c8e6c9',
    legendSubtitleColor: '#81c784',
    legendSwatchBorder: '#4caf50',
  },
};

interface GroupedCountryTier {
  countryCodes: string[];
  minAmount: number;
  maxAmount: number;
  tier: number;
}

@injectable()
export class WorldMapGenerator {
  private worldHtmlTemplate: string = '';

  constructor(
    @inject(PuppeteerService) private readonly puppeteerService: PuppeteerService,
  ) {
    const candidatePaths = [
      path.join(__dirname, '..', 'pages', 'world.html'),
      path.join(process.cwd(), 'src', 'images', 'pages', 'world.html'),
      path.join(process.cwd(), 'dist', 'images', 'pages', 'world.html'),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        this.worldHtmlTemplate = fs.readFileSync(p, 'utf8');
        break;
      }
    }
  }

  public static getThemeFromName(name?: string): CountryChartTheme {
    if (!name) return CountryChartTheme.Dark;
    const clean = name.trim().toLowerCase();
    switch (clean) {
      case 'light':
        return CountryChartTheme.Light;
      case 'ocean':
        return CountryChartTheme.Ocean;
      case 'synthwave':
        return CountryChartTheme.Synthwave;
      case 'sunset':
        return CountryChartTheme.Sunset;
      case 'forest':
        return CountryChartTheme.Forest;
      case 'dark':
      default:
        return CountryChartTheme.Dark;
    }
  }

  public static getThemeName(theme: CountryChartTheme): string {
    switch (theme) {
      case CountryChartTheme.Light:
        return 'Light';
      case CountryChartTheme.Ocean:
        return 'Ocean';
      case CountryChartTheme.Synthwave:
        return 'Synthwave';
      case CountryChartTheme.Sunset:
        return 'Sunset';
      case CountryChartTheme.Forest:
        return 'Forest';
      case CountryChartTheme.Dark:
      default:
        return 'Dark';
    }
  }

  private getGroupedCountries(countries: TopCountryItem[]): GroupedCountryTier[] {
    const list: GroupedCountryTier[] = [];
    if (!countries || countries.length === 0) return list;

    const ceilings = [5, 30, 80, 200, 500, 10000];
    const grouped = new Map<number, TopCountryItem[]>();

    for (const item of countries) {
      const count = item.artists ? item.artists.length : (item.artistCount ?? 1);
      const ceiling = ceilings.find(c => c >= count) ?? 10000;
      if (!grouped.has(ceiling)) grouped.set(ceiling, []);
      grouped.get(ceiling)!.push(item);
    }

    const sortedCeilings = Array.from(grouped.keys()).sort((a, b) => b - a);
    let tier = 0;

    for (const ceiling of sortedCeilings) {
      const items = grouped.get(ceiling)!;
      const counts = items.map(i => (i.artists ? i.artists.length : (i.artistCount ?? 1)));
      const minAmount = Math.min(...counts);
      const maxAmount = Math.max(...counts);
      const countryCodes = items.map(i => i.countryCode.toLowerCase());

      list.push({
        countryCodes,
        minAmount,
        maxAmount,
        tier,
      });
      tier++;
    }

    return list;
  }

  private buildLegendSvg(
    lines: GroupedCountryTier[],
    totalCountries: number,
    palette: WorldMapThemePalette,
  ): string {
    const padding = 40;
    const legendItemHeight = 55;
    const colorBoxSize = 40;
    const colorBoxMargin = 20;
    const legendWidth = 400;
    const legendHeight = 120 + (lines.length * legendItemHeight) + 80;
    const legendLeft = 80;
    const legendTop = 1398 - legendHeight - 80;

    const bgX = legendLeft - padding;
    const bgY = legendTop - padding;
    const bgW = legendWidth + padding * 2;
    const bgH = legendHeight + padding * 2;

    const titleY = legendTop + 50;
    const titleX = legendLeft + legendWidth / 2;

    let itemsSvg = '';
    let currentY = titleY + 80;

    for (const line of lines) {
      const swatchFill = palette.countryRamp[Math.min(line.tier, palette.countryRamp.length - 1)];
      const swatchX = legendLeft + colorBoxMargin;
      const swatchY = currentY - colorBoxSize + 12;
      const textX = swatchX + colorBoxSize + 30;
      const text = line.minAmount === line.maxAmount ? `${line.minAmount}` : `${line.minAmount} - ${line.maxAmount}`;

      itemsSvg += `
        <rect x="${swatchX}" y="${swatchY}" width="${colorBoxSize}" height="${colorBoxSize}" rx="8" ry="8" fill="${swatchFill}" stroke="${palette.legendSwatchBorder}" stroke-width="2" />
        <text x="${textX}" y="${currentY + 18}" fill="${palette.legendTitleColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="28" font-weight="600" dominant-baseline="middle">${text}</text>
      `;
      currentY += legendItemHeight;
    }

    const footerY = currentY + 40;

    return `
      <g id="map-legend">
        <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="20" ry="20" fill="${palette.legendBoxFill}" stroke="${palette.legendBoxBorder}" stroke-width="2" />
        <text x="${titleX}" y="${titleY}" text-anchor="middle" fill="${palette.legendTitleColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="42" font-weight="bold">Artists per country</text>
        ${itemsSvg}
        <text x="${titleX}" y="${footerY}" text-anchor="middle" fill="${palette.legendSubtitleColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="28">${totalCountries} countries</text>
        <text x="${titleX}" y="${footerY + 35}" text-anchor="middle" fill="${palette.legendSubtitleColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="28">Generated by tvbot</text>
      </g>
    `;
  }

  public async generateWorldMap(
    countries: TopCountryItem[],
    theme: CountryChartTheme = CountryChartTheme.Dark,
  ): Promise<Buffer> {
    const palette = WORLD_MAP_THEMES[theme] ?? WORLD_MAP_THEMES[CountryChartTheme.Dark];
    const groupedLines = this.getGroupedCountries(countries);

    let customCss = '';
    let totalCountries = 0;

    for (const line of groupedLines) {
      const fill = palette.countryRamp[Math.min(line.tier, palette.countryRamp.length - 1)];
      for (const code of line.countryCodes) {
        customCss += `.${code.toLowerCase()}{fill:${fill}} `;
        totalCountries++;
      }
    }

    const legendSvg = this.buildLegendSvg(groupedLines, totalCountries, palette);

    let template = this.worldHtmlTemplate;
    if (!template) {
      const fallbackPath = path.join(process.cwd(), 'src', 'images', 'pages', 'world.html');
      template = fs.readFileSync(fallbackPath, 'utf8');
    }

    const html = template
      .replace('{{svgbg}}', palette.svgBackground)
      .replace('{{oceanfill}}', palette.oceanFill)
      .replace('{{landfill}}', palette.landFill)
      .replace('{{landstroke}}', palette.landStroke)
      .replace('{{landstrokewidth}}', palette.landStrokeWidth)
      .replace('{{customcss}}', customCss)
      .replace('</svg>', `${legendSvg}</svg>`);

    return this.puppeteerService.screenshotHtml(html, 2754, 1398);
  }
}
