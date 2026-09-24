import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { chapterIndexAt, isGenericChapterTitle, splitChapterTitle, extractArtistFromTitle, resolveDisplayedChapter } from './videoChapters';

const SHOW = [
  { title: 'Rottweiler', startMs: 0 },
  { title: '4 Raws', startMs: 150000 },
  { title: 'Century', startMs: 355000 },
];

describe('chapterIndexAt', () => {
  it('picks the last started chapter', () => {
    expect(chapterIndexAt(SHOW, 0)).toBe(0);
    expect(chapterIndexAt(SHOW, 200000)).toBe(1);
    expect(chapterIndexAt(SHOW, 999999)).toBe(2);
  });

  it('applies the startup offset like the lyric clock', () => {
    expect(chapterIndexAt(SHOW, 151000, 3000)).toBe(0);
    expect(chapterIndexAt(SHOW, 151000)).toBe(1);
  });

  it('rejects unusable input', () => {
    expect(chapterIndexAt(null, 5000)).toBe(-1);
    expect(chapterIndexAt([], 5000)).toBe(-1);
    expect(chapterIndexAt([{ title: 'Whole thing', startMs: 0 }], 5000)).toBe(-1);
  });

  it('skips malformed entries', () => {
    const messy = [
      { title: 'A', startMs: 0 },
      { title: 'bad', startMs: NaN },
      { title: 'B', startMs: 60000 },
    ];
    expect(chapterIndexAt(messy, 70000)).toBe(2);
  });
});

describe('isGenericChapterTitle', () => {
  it('flags container titles', () => {
    expect(isGenericChapterTitle('Intro')).toBe(true);
    expect(isGenericChapterTitle('intro part 2')).toBe(true);
    expect(isGenericChapterTitle('')).toBe(true);
    expect(isGenericChapterTitle(null)).toBe(true);
  });

  it('keeps real song titles', () => {
    expect(isGenericChapterTitle('Rottweiler')).toBe(false);
    expect(isGenericChapterTitle('4 Raws')).toBe(false);
  });
});

describe('splitChapterTitle', () => {
  it('splits artist and song', () => {
    expect(splitChapterTitle('EsDeeKid - Rottweiler')).toEqual({ artist: 'EsDeeKid', song: 'Rottweiler' });
  });

  it('strips track numbers and keeps song-only titles', () => {
    expect(splitChapterTitle('01. Rottweiler')).toEqual({ song: 'Rottweiler' });
    expect(splitChapterTitle('Rottweiler')).toEqual({ song: 'Rottweiler' });
  });
});

describe('extractArtistFromTitle', () => {
  it('finds the performer in a live video title', () => {
    expect(extractArtistFromTitle('EsDeeKid - Live at Silver Spring, MD [FULL SET | 9/13/26]')).toBe('EsDeeKid');
  });

  it('rejects non-artists and missing patterns', () => {
    expect(extractArtistFromTitle('Rottweiler')).toBeNull();
    expect(extractArtistFromTitle('Live - Full Set')).toBeNull();
    expect(extractArtistFromTitle('')).toBeNull();
    expect(extractArtistFromTitle(null)).toBeNull();
  });
});

describe('resolveDisplayedChapter', () => {
  it('holds the previous cover while the new one resolves', () => {
    expect(
      resolveDisplayedChapter({ title: '4 Raws', artworkUrl: null }, 'https://cdn.example.com/rottweiler.jpg', 'https://cdn.example.com/artist.jpg'),
    ).toEqual({
      card: { title: '4 Raws', artworkUrl: 'https://cdn.example.com/rottweiler.jpg' },
      shownCover: 'https://cdn.example.com/rottweiler.jpg',
    });
  });

  it('prefers fresh chapter art over the held cover', () => {
    expect(
      resolveDisplayedChapter({ title: 'Century', artworkUrl: 'https://cdn.example.com/century.jpg' }, 'https://cdn.example.com/old.jpg', null),
    ).toEqual({
      card: { title: 'Century', artworkUrl: 'https://cdn.example.com/century.jpg' },
      shownCover: 'https://cdn.example.com/century.jpg',
    });
  });

  it('falls back to track art with no chapter and no hold', () => {
    expect(resolveDisplayedChapter(null, null, 'https://cdn.example.com/video.jpg')).toEqual({
      card: null,
      shownCover: 'https://cdn.example.com/video.jpg',
    });
  });
});
