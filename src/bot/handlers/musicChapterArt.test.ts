import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MusicHandler } from './musicHandler';

const makeHandler = (artworkService: unknown) => {
  const manager = { on: vi.fn(), players: { get: () => undefined } };
  const client = { on: vi.fn(), channels: { cache: new Map() } };
  const handler = new MusicHandler(
    client as never,
    { getManager: () => manager } as never,
    { getQueueInfo: () => null, is247: () => false } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    artworkService as never,
  );
  return handler as unknown as {
    getChapterCover: (chapterTitle: string, song: string, artist: string | undefined) => Promise<string | null>;
  };
};

describe('MusicHandler chapter cover lookup (transition fallback)', () => {
  it('retries medley titles with the lead song when the full title misses', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const svc = {
      getTrackCoverUrl: vi.fn(async (song: string, artist: string | undefined) => {
        calls.push([song, artist]);
        return song === 'BACKR00MS' ? 'https://cdn.example.com/backr00ms.jpg' : null;
      }),
    };
    const handler = makeHandler(svc);
    await expect(
      handler.getChapterCover('BACKR00MS TO KICK OUT', 'BACKR00MS TO KICK OUT', 'TRAVIS SCOTT'),
    ).resolves.toBe('https://cdn.example.com/backr00ms.jpg');
    expect(calls).toEqual([
      ['BACKR00MS TO KICK OUT', 'TRAVIS SCOTT'],
      ['BACKR00MS', 'TRAVIS SCOTT'],
    ]);
  });

  it('does not retry when the full title resolves', async () => {
    const svc = { getTrackCoverUrl: vi.fn(async () => 'https://cdn.example.com/sicko.jpg') };
    const handler = makeHandler(svc);
    await expect(handler.getChapterCover('SICKO MODE', 'SICKO MODE', 'TRAVIS SCOTT')).resolves.toBe(
      'https://cdn.example.com/sicko.jpg',
    );
    expect(svc.getTrackCoverUrl).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the title is not a transition', async () => {
    const svc = { getTrackCoverUrl: vi.fn(async () => null) };
    const handler = makeHandler(svc);
    await expect(handler.getChapterCover('CHAMPAIN & VACAY', 'CHAMPAIN & VACAY', 'TRAVIS SCOTT')).resolves.toBeNull();
    expect(svc.getTrackCoverUrl).toHaveBeenCalledTimes(1);
  });
});
