import { readFileSync } from 'fs';
import path from 'path';
import type { ChartItem, ChartSettings } from '@images/models/chartModels';
import { PuppeteerService } from './puppeteerService';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

let cachedFontCss: string | null = null;
function getFontCss(): string {
  if (cachedFontCss === null) {
    try {
      const fontCssPath = path.resolve(__dirname, '../pages/fonts.css');
      cachedFontCss = readFileSync(fontCssPath, 'utf-8');
    } catch {
      cachedFontCss = '';
    }
  }
  return cachedFontCss;
}

export class ChartService {
  private readonly puppeteer: PuppeteerService;

  constructor(puppeteer: PuppeteerService) {
    this.puppeteer = puppeteer;
  }

  public async generateChart(
    items: ChartItem[],
    settings: ChartSettings,
  ): Promise<Buffer> {
    const html = this.buildChartHtml(items, settings);
    const totalWidth =
      settings.columns * (settings.imageSizePx + settings.padding * 2) +
      settings.padding * 2;
    const titleHeight = settings.showTitle ? 46 : 0;
    const totalHeight =
      settings.rows * (settings.imageSizePx + settings.padding * 2) +
      settings.padding * 2 +
      titleHeight;

    if (settings.rainbowSort) {
      return this.puppeteer.screenshotHtmlWithRainbowSort(html, totalWidth, totalHeight);
    }
    return this.puppeteer.screenshotHtml(html, totalWidth, totalHeight);
  }

  private buildChartHtml(items: ChartItem[], settings: ChartSettings): string {
    const templatePath = path.resolve(__dirname, '../pages/chart.html');
    let template = readFileSync(templatePath, 'utf-8');
    const fontCss = getFontCss();

    const size = settings.imageSizePx;
    const gap = settings.padding > 0 ? Math.max(2, Math.round(settings.padding / 2)) : 0;
    const cells = items
      .slice(0, settings.rows * settings.columns)
      .map((item) => this.buildCell(item, size))
      .join('');

    const titleHtml = settings.showTitle && settings.title
      ? `<div class="title">${escapeHtml(settings.title)}</div>`
      : '';

    const fontStack = settings.fontFamily
      ? `'${settings.fontFamily.replace(/['\\]/g, '')}', 'Readex Pro', 'Cairo', 'Rubik', 'Noto Sans Arabic', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
      : `'Readex Pro', 'Cairo', 'Rubik', 'Noto Sans Arabic', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;

    const isLarge = size >= 240;
    const topFontSize = isLarge ? Math.max(14, Math.round(size * 0.052)) : Math.max(11, Math.round(size * 0.058));
    const bottomFontSize = isLarge ? Math.max(12, Math.round(size * 0.044)) : Math.max(9, Math.round(size * 0.05));
    const labelPaddingX = isLarge ? 8 : 5;
    const labelPaddingY = isLarge ? 3 : 2;
    const labelBottomOffset = isLarge ? 5 : 3;

    template = template
      .replaceAll('{{padding}}', String(settings.padding))
      .replaceAll('{{columns}}', String(settings.columns))
      .replaceAll('{{size}}', String(size))
      .replaceAll('{{gap}}', String(gap))
      .replaceAll('{{sizeFallbackText}}', String(Math.max(11, Math.round(size / 10))))
      .replaceAll('{{topFontSize}}', String(topFontSize))
      .replaceAll('{{bottomFontSize}}', String(bottomFontSize))
      .replaceAll('{{labelPaddingX}}', String(labelPaddingX))
      .replaceAll('{{labelPaddingY}}', String(labelPaddingY))
      .replaceAll('{{labelBottomOffset}}', String(labelBottomOffset))
      .replaceAll('{{fontCss}}', fontCss)
      .replaceAll('{{fontFamily}}', fontStack)
      .replaceAll('{{titleHtml}}', titleHtml)
      .replaceAll('{{cells}}', cells);

    return template;
  }

  private buildCell(item: ChartItem, size: number): string {
    const hasArtist = Boolean(item.artistName && item.artistName.trim().length > 0);
    const topText = hasArtist ? item.artistName! : item.name;
    const bottomText = hasArtist ? item.name : undefined;

    let labelHtml = '';
    if (item.showTitle && topText) {
      labelHtml = `<div class="label theme-dark">` +
        `<span class="top-text">${escapeHtml(topText)}</span>` +
        (bottomText ? `<span class="bottom-text">${escapeHtml(bottomText)}</span>` : '') +
        `</div>`;
    }

    if (item.imageUrl) {
      return (
        `<div class="cell">` +
        `<img src="${escapeHtml(item.imageUrl)}" width="${size}" height="${size}" crossorigin="anonymous" />` +
        labelHtml +
        `</div>`
      );
    }

    return (
      `<div class="cell">` +
      `<div class="fallback">` +
      `<span class="fallback-artist">${escapeHtml(topText)}</span>` +
      (bottomText ? `<span class="fallback-album">${escapeHtml(bottomText)}</span>` : '') +
      `</div>` +
      `</div>`
    );
  }
}
