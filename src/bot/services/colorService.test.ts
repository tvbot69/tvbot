import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { ColorService } from './colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';

describe('ColorService accent failure cooldown', () => {
  const RED = DiscordConstants.LastFmColorRed;
  const keyFor = (url: string) =>
    `accent-color:image:${crypto.createHash('md5').update(url.trim()).digest('hex')}`;

  const makeSvc = (cached: number | null = null) => {
    const cache = { get: vi.fn(async () => cached), set: vi.fn(async () => undefined) };
    const svc = new ColorService(cache as never);
    return { svc, cache };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caches red for 10 minutes when the image fetch fails', async () => {
    const { svc, cache } = makeSvc();
    const url = 'https://img.test/broken.jpg';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
    const color = await svc.getColorFromImageUrl(url);
    expect(color).toBe(RED);
    expect(cache.set).toHaveBeenCalledWith(keyFor(url), RED, 600);
  });

  it('caches red when the image request throws', async () => {
    const { svc, cache } = makeSvc();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));
    const color = await svc.getColorFromImageUrl('https://img.test/unreachable.jpg');
    expect(color).toBe(RED);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^accent-color:image:/),
      RED,
      600,
    );
  });

  it('serves cached red without re-downloading a known-bad image', async () => {
    const { svc, cache } = makeSvc(RED);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response);
    const color = await svc.getColorFromImageUrl('https://img.test/broken.jpg');
    expect(color).toBe(RED);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('still caches genuine colors for the full TTL', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 60, b: 200 } },
    })
      .png()
      .toBuffer();
    const { svc, cache } = makeSvc(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    } as unknown as Response);
    const url = 'https://img.test/solid.jpg';
    const color = await svc.getColorFromImageUrl(url);
    expect(color).not.toBe(RED);
    expect(cache.set).toHaveBeenCalledWith(keyFor(url), color, 86400);
  });
});
