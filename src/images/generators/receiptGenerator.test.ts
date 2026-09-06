import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ReceiptGenerator, ReceiptData } from './receiptGenerator';
import { PuppeteerService } from './puppeteerService';

describe('ReceiptGenerator', () => {
  it('replaces all placeholders and renders receipt through Puppeteer', async () => {
    let capturedHtml = '';
    let capturedWidth = 0;
    let capturedHeight = 0;

    const mockPuppeteer = {
      screenshotHtml: vi.fn().mockImplementation(async (html: string, width: number, height: number) => {
        capturedHtml = html;
        capturedWidth = width;
        capturedHeight = height;
        return Buffer.from('mock_receipt_png');
      }),
    } as unknown as PuppeteerService;

    const generator = new ReceiptGenerator(mockPuppeteer);

    const testData: ReceiptData = {
      userNameLastFm: 'musiclover',
      displayName: 'Music Lover',
      periodDescription: 'Last 7 days',
      tracks: [
        { artistName: 'Radiohead', trackName: 'Paranoid Android', userPlaycount: 42 },
        { artistName: 'Kendrick Lamar', trackName: 'HUMBLE.', userPlaycount: 35 },
      ],
      totalPlays: 77,
      totalTracks: 2,
      orderNumber: 1337,
      authCode: '987654',
      year: 2026,
    };

    const buffer = await generator.generateReceipt(testData);

    expect(buffer).toBeDefined();
    expect(mockPuppeteer.screenshotHtml).toHaveBeenCalled();
    expect(capturedWidth).toBe(500);
    expect(capturedHeight).toBeGreaterThanOrEqual(500);

    expect(capturedHtml).toContain('Radiohead - Paranoid Android');
    expect(capturedHtml).toContain('Kendrick Lamar - HUMBLE.');
    expect(capturedHtml).toContain('musiclover');
    expect(capturedHtml).toContain('Music Lover');
    expect(capturedHtml).toContain('LAST 7 DAYS');
    expect(capturedHtml).toContain('ORDER #1337');
    expect(capturedHtml).toContain('AUTH CODE: 987654');
    expect(capturedHtml).toContain('CARD #: **** **** **** 2026');
    expect(capturedHtml).toContain('Thank you for using tvbot - Enjoy the music!');
  });
});
