import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { IcebergGenerator } from './icebergGenerator';
import { PuppeteerService } from './puppeteerService';
import type { IcebergData } from '@bot/services/musicIntelligenceService';

describe('IcebergGenerator', () => {
  it('renders all iceberg tiers and artists into HTML and screenshots via Puppeteer', async () => {
    let capturedHtml = '';
    let capturedWidth = 0;
    let capturedHeight = 0;

    const mockPuppeteer = {
      screenshotHtml: vi.fn().mockImplementation(async (html: string, width: number, height: number) => {
        capturedHtml = html;
        capturedWidth = width;
        capturedHeight = height;
        return Buffer.from('mock_iceberg_png');
      }),
    } as unknown as PuppeteerService;

    const generator = new IcebergGenerator(mockPuppeteer);

    const testData: IcebergData = {
      displayName: 'Moha',
      userNameLastFm: 'Moha504',
      timePeriodDescription: 'Overall',
      totalArtists: 40,
      tiers: [
        {
          tierNumber: 1,
          name: 'Tip of the Iceberg',
          emoji: '🏔️',
          description: 'Mega mainstream',
          artists: [{ name: 'Future', playcount: 800 }, { name: 'Drake', playcount: 750 }],
        },
        {
          tierNumber: 2,
          name: 'The Surface',
          emoji: '🌊',
          description: 'Widely known',
          artists: [{ name: 'Kendrick Lamar', playcount: 600 }, { name: 'Travis Scott', playcount: 550 }],
        },
        {
          tierNumber: 3,
          name: 'Shallow Waters',
          emoji: '⚓',
          description: 'Popular',
          artists: [{ name: 'Metro Boomin', playcount: 400 }],
        },
        {
          tierNumber: 4,
          name: 'The Deep',
          emoji: '🪨',
          description: 'Moderate',
          artists: [{ name: 'Gunna', playcount: 300 }],
        },
        {
          tierNumber: 5,
          name: 'Twilight Zone',
          emoji: '🐙',
          description: 'Niche',
          artists: [{ name: 'Young Nudy', playcount: 200 }],
        },
        {
          tierNumber: 6,
          name: 'The Abyss',
          emoji: '🌌',
          description: 'Obscure',
          artists: [{ name: 'SahBabii', playcount: 100 }],
        },
        {
          tierNumber: 7,
          name: 'The Trench',
          emoji: '⬛',
          description: 'Underground',
          artists: [{ name: 'UnoTheActivist', playcount: 50 }],
        },
      ],
    };

    const buffer = await generator.generateIceberg(testData);

    expect(buffer).toBeDefined();
    expect(mockPuppeteer.screenshotHtml).toHaveBeenCalled();
    expect(capturedWidth).toBe(920);
    expect(capturedHeight).toBe(1320);

    expect(capturedHtml).toContain("MOHA'S MUSIC ICEBERG");
    expect(capturedHtml).toContain('Future');
    expect(capturedHtml).toContain('Drake');
    expect(capturedHtml).toContain('Kendrick Lamar');
    expect(capturedHtml).toContain('UnoTheActivist');
    expect(capturedHtml).toContain('SEA LEVEL');
    expect(capturedHtml).toContain('tvbot music intelligence');
  });
});
