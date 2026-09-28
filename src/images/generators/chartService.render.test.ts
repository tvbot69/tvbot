import 'reflect-metadata';
import { describe, it, expect, afterAll } from 'vitest';
import { ChartService } from './chartService';
import { PuppeteerService } from './puppeteerService';
import { ChartTheme, ChartType } from '@images/models/chartModels';

const puppeteer = new PuppeteerService();
const service = new ChartService(puppeteer);

afterAll(async () => {
  await puppeteer.close();
});

describe('ChartService.generateChart', () => {
  it('renders a 3x3 grid to valid PNG bytes', async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      name: `Item ${i + 1}`,
      artistName: `Artist ${i + 1}`,
      imageUrl: undefined,
      sizePx: undefined,
    }));

    const png = await service.generateChart(items, {
      rows: 3,
      columns: 3,
      type: ChartType.Artist,
      theme: ChartTheme.Dark,
      title: 'Test chart',
      showTitle: true,
      padding: 6,
      imageSizePx: 150,
      timePeriod: 'AllTime' as never,
    });

    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png.toString('ascii', 1, 4)).toBe('PNG');
  }, 60000);

  it('renders cells with images without throwing', async () => {
    const items = [
      { name: 'Cover', imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
      { name: 'No cover' },
    ];

    const png = await service.generateChart(items, {
      rows: 1,
      columns: 2,
      type: ChartType.Album,
      theme: ChartTheme.Light,
      showTitle: false,
      padding: 4,
      imageSizePx: 120,
      timePeriod: 'Weekly' as never,
    });

    expect(png.length).toBeGreaterThan(500);
  }, 60000);
});
