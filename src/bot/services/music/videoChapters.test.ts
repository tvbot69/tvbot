import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { chapterIndexAt, isGenericChapterTitle, splitChapterTitle } from './videoChapters';

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
