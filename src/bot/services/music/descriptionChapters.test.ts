import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDescriptionChapters, parseTimestampLines, __resetDescriptionChaptersForTests } from './descriptionChapters';

const SAVED_KEY = process.env.YOUTUBE_API_KEY;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

const desc = (description: string) => ok({ items: [{ snippet: { description } }] });

const setKey = (key?: string) => {
  if (key === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = key;
};

describe('parseTimestampLines', () => {
  it('parses m:ss and h:mm:ss with common separators and sorts', () => {
    expect(
      parseTimestampLines(
        [
          'Some Set',
          '',
          '17:00 - RockWave',
          '0:00 - Rottweiler',
          '1:02:03 Closer',
          '(2:30) 4 Raws',
          '[5:55] Century',
          '- 8:40 Panic',
          '00:00 Intro',
        ].join('\n'),
      ),
    ).toEqual([
      { title: 'Rottweiler', startMs: 0 },
      { title: 'Intro', startMs: 0 },
      { title: '4 Raws', startMs: 150_000 },
      { title: 'Century', startMs: 355_000 },
      { title: 'Panic', startMs: 520_000 },
      { title: 'RockWave', startMs: 1_020_000 },
      { title: 'Closer', startMs: 3_723_000 },
    ]);
  });

  it('falls back to a numbered title when the line is timestamp-only', () => {
    expect(parseTimestampLines('0:00\n1:30')).toEqual([
      { title: 'Chapter 1', startMs: 0 },
      { title: 'Chapter 2', startMs: 90_000 },
    ]);
  });

  it('ignores prose that merely mentions a time', () => {
    expect(parseTimestampLines('doors open at 17:00 sharp\nout now everywhere')).toEqual([]);
  });

  it('parses title-first lines ("INTRO - 00:00") used by live/DJ descriptions', () => {
    expect(
      parseTimestampLines(
        [
          'TRAVIS SCOTT LIVE - THE TOWN FESTIVAL 2025 (FULL SET)',
          '',
          'TIMESTAMPS:',
          '',
          'INTRO - 00:00',
          'CHAMPAIN & VACAY - 00:20',
          'UPPER ECHELON - 21:52 ',
          'FE!N (X2) - 43:00',
          'TELEKINESIS - 51:34',
        ].join('\n'),
      ),
    ).toEqual([
      { title: 'INTRO', startMs: 0 },
      { title: 'CHAMPAIN & VACAY', startMs: 20_000 },
      { title: 'UPPER ECHELON', startMs: 1_312_000 },
      { title: 'FE!N (X2)', startMs: 2_580_000 },
      { title: 'TELEKINESIS', startMs: 3_094_000 },
    ]);
  });

  it('keeps full titles containing dashes and accepts dash variants and pipes', () => {
    expect(parseTimestampLines('A - B - 1:00\nC | 2:30\nD – 3:00')).toEqual([
      { title: 'A - B', startMs: 60_000 },
      { title: 'C', startMs: 150_000 },
      { title: 'D', startMs: 180_000 },
    ]);
  });

  it('parses mixed leading and trailing formats in one description', () => {
    expect(parseTimestampLines('0:00 - Opener\nMid - 5:00\n1:02:03 - Closer')).toEqual([
      { title: 'Opener', startMs: 0 },
      { title: 'Mid', startMs: 300_000 },
      { title: 'Closer', startMs: 3_723_000 },
    ]);
  });

  it('does not treat colon-prose or trailing-text lines as chapters', () => {
    expect(parseTimestampLines('Premiere: 21:00\nupdated - see pinned comment\nSet: 1:30 (live)')).toEqual([]);
  });
});

describe('fetchDescriptionChapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDescriptionChaptersForTests();
    setKey('test-key');
  });

  afterEach(() => {
    setKey(SAVED_KEY);
  });

  it('calls the Data API and maps description timestamps', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(desc('EsDeeKid Live\n\n0:00 - Rottweiler\n2:30 - 4 Raws\n1:02:03 - Closer'));
    await expect(fetchDescriptionChapters('dQw4w9WgXcQ')).resolves.toEqual([
      { title: 'Rottweiler', startMs: 0 },
      { title: '4 Raws', startMs: 150_000 },
      { title: 'Closer', startMs: 3_723_000 },
    ]);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.hostname).toBe('www.googleapis.com');
    expect(url.pathname).toBe('/youtube/v3/videos');
    expect(url.searchParams.get('id')).toBe('dQw4w9WgXcQ');
    expect(url.searchParams.get('part')).toBe('snippet');
  });

  it('serves the second call from cache with a single fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(desc('0:00 A\n1:00 B'));
    await fetchDescriptionChapters('cache0Hit00');
    await expect(fetchDescriptionChapters('cache0Hit00')).resolves.toEqual([
      { title: 'A', startMs: 0 },
      { title: 'B', startMs: 60_000 },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('negative-caches API failures for 10 minutes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(fetchDescriptionChapters('api0fail000')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('api0fail000')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('negative-caches missing videos (empty items)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ items: [] }));
    await expect(fetchDescriptionChapters('gone0video0')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('gone0video0')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns [] (cached) when the description has no timestamp lines', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(desc('no chapters here\njust lyrics'));
    await expect(fetchDescriptionChapters('no0stamp000')).resolves.toEqual([]);
    await expect(fetchDescriptionChapters('no0stamp000')).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null without fetching when no key is configured', async () => {
    setKey(undefined);
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchDescriptionChapters('dQw4w9WgXcQ')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects invalid video ids without any fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchDescriptionChapters('short')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
