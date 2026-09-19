import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsGenerator } from './whoKnowsGenerator';

const captureHtml = async (params: Record<string, unknown>): Promise<string> => {
  let captured = '';
  const mockPuppeteer = {
    screenshotHtml: vi.fn(async (html: string) => {
      captured = html;
      return Buffer.from('fake');
    }),
  };
  const generator = new WhoKnowsGenerator(mockPuppeteer as never);
  await generator.generateWhoKnowsImage({
    type: 'Who Knows Artist',
    title: 'Mond',
    location: 'Server',
    users: [{ userId: 1, playcount: 125, lastFmUsername: 'hamzahesham' }],
    ...params,
  } as never);
  return captured;
};

describe('WhoKnows mosaic wallpaper', () => {
  it('renders exactly 10 large tiles (5x2)', async () => {
    const html = await captureHtml({
      backgroundCovers: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    });
    const tiles = html.match(/class="mosaic-tile"><img/g) ?? [];
    expect(tiles).toHaveLength(10);
  });

  it('cycles provided covers across tiles', async () => {
    const html = await captureHtml({
      backgroundCovers: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    });
    const aCount = (html.match(/cdn\.example\/a\.jpg/g) ?? []).length;
    const bCount = (html.match(/cdn\.example\/b\.jpg/g) ?? []).length;
    expect(aCount).toBe(5);
    expect(bCount).toBe(5);
  });

  it('falls back to the main artwork (never a broken tile) when no covers given', async () => {
    const html = await captureHtml({ imageUrl: 'https://cdn.example/hero.jpg' });
    const tiles = html.match(/class="mosaic-tile"><img/g) ?? [];
    expect(tiles).toHaveLength(10);
    expect(html).toContain('cdn.example/hero.jpg');
  });
});
