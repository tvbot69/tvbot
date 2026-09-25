import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { chapterIndexAt, isGenericChapterTitle, splitChapterTitle, extractArtistFromTitle, resolveDisplayedChapter, getVideoTitle, getSourceVideoId } from './videoChapters';

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

  it('flags slash-joined container titles', () => {
    expect(isGenericChapterTitle('Intro/Outro')).toBe(true);
    expect(isGenericChapterTitle('Intro / Outro')).toBe(true);
    expect(isGenericChapterTitle('intro|outro')).toBe(true);
  });

  it('keeps mixed slash titles with a real song', () => {
    expect(isGenericChapterTitle('Intro / Rottweiler')).toBe(false);
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

  it('splits en/em-dash separators', () => {
    expect(splitChapterTitle('Rihanna – Diamonds')).toEqual({ artist: 'Rihanna', song: 'Diamonds' });
    expect(splitChapterTitle('Rihanna — Diamonds')).toEqual({ artist: 'Rihanna', song: 'Diamonds' });
  });

  it('strips track numbers and keeps song-only titles', () => {
    expect(splitChapterTitle('01. Rottweiler')).toEqual({ song: 'Rottweiler' });
    expect(splitChapterTitle('Rottweiler')).toEqual({ song: 'Rottweiler' });
  });

  it('treats performance suffixes as the song, not a split', () => {
    expect(splitChapterTitle('SICKO MODE - Live')).toEqual({ song: 'SICKO MODE' });
    expect(splitChapterTitle('BUTTERFLY EFFECT - Live Version')).toEqual({ song: 'BUTTERFLY EFFECT' });
    expect(splitChapterTitle('FE!N - Live at Glastonbury')).toEqual({ song: 'FE!N' });
    expect(splitChapterTitle('FE!N – Acoustic')).toEqual({ song: 'FE!N' });
  });

  it('still splits real artist/song pairs', () => {
    expect(splitChapterTitle('Travis Scott - SICKO MODE')).toEqual({ artist: 'Travis Scott', song: 'SICKO MODE' });
    expect(splitChapterTitle('Live and Let Die - Remaster')).toEqual({ artist: 'Live and Let Die', song: 'Remaster' });
  });
});

describe('extractArtistFromTitle', () => {
  it('finds the performer in a live video title', () => {
    expect(extractArtistFromTitle('EsDeeKid - Live at Silver Spring, MD [FULL SET | 9/13/26]')).toBe('EsDeeKid');
  });

  it('finds the performer with en-dash separators', () => {
    expect(extractArtistFromTitle('Rihanna – Live at Home')).toBe('Rihanna');
  });

  it('strips trailing set noise from the artist segment', () => {
    expect(extractArtistFromTitle('TRAVIS SCOTT LIVE - THE TOWN FESTIVAL 2025 (FULL SET)')).toBe('TRAVIS SCOTT');
    expect(extractArtistFromTitle('Drake FULL SET - Assassin Tour')).toBe('Drake');
    expect(extractArtistFromTitle('Travis Scott Live Concert - Town Festival')).toBe('Travis Scott');
  });

  it('rejects non-artists and missing patterns', () => {
    expect(extractArtistFromTitle('Rottweiler')).toBeNull();
    expect(extractArtistFromTitle('Live - Full Set')).toBeNull();
    expect(extractArtistFromTitle('LIVE FULL SET - Town Festival')).toBeNull();
    expect(extractArtistFromTitle('')).toBeNull();
    expect(extractArtistFromTitle(null)).toBeNull();
  });
});

describe('getVideoTitle/getSourceVideoId', () => {
  it('prefers the stashed raw video title over the adopted Spotify title', () => {
    const track = { title: 'Diamonds', _rawVideoTitle: 'Rihanna - Live at Home' } as unknown as { title: string };
    expect(getVideoTitle(track)).toBe('Rihanna - Live at Home');
    expect(extractArtistFromTitle(getVideoTitle(track))).toBe('Rihanna');
  });

  it('resolves video IDs for youtube, adopted spotify, and stamped local tracks', () => {
    expect(getSourceVideoId({ sourceName: 'youtube', identifier: 'dQw4w9WgXcQ' })).toBe('dQw4w9WgXcQ');
    expect(getSourceVideoId({ sourceName: 'spotify', identifier: 'dQw4w9WgXcQ' })).toBe('dQw4w9WgXcQ');
    expect(
      getSourceVideoId({ sourceName: 'local', identifier: 'local-cache-id', _sourceVideoId: 'dQw4w9WgXcQ' } as unknown as { sourceName: string; identifier: string }),
    ).toBe('dQw4w9WgXcQ');
    expect(getSourceVideoId({ sourceName: 'soundcloud', identifier: 'dQw4w9WgXcQ' })).toBeNull();
    expect(getSourceVideoId({ sourceName: 'local', identifier: 'local-cache-id' })).toBeNull();
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
