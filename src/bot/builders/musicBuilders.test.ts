import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MusicBuilders } from './musicBuilders';

describe('buildLyricSection', () => {
  it('renders current plus next line', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: 'Is it me' })).toBe(
      '🎤 **Hello**\nIs it me',
    );
  });

  it('omits the next line when the song ends', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Goodbye', next: null })).toBe('🎤 **Goodbye**');
  });

  it('shows the upcoming line before the first timestamp', () => {
    expect(MusicBuilders.buildLyricSection({ current: null, next: 'Hello' })).toBe('🎤 ♪\nHello');
  });

  it('returns null when nothing is singable', () => {
    expect(MusicBuilders.buildLyricSection(null)).toBeNull();
    expect(MusicBuilders.buildLyricSection({ current: null, next: null })).toBeNull();
  });

  it('renders embed-safe markdown for the legacy fallback', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: 'Is it me' }, false)).toBe(
      '🎤 **Hello**\n*Is it me*',
    );
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: null }, false)).toBe('🎤 **Hello**');
    expect(MusicBuilders.buildLyricSection(null, false)).toBeNull();
  });
});

const npQueue = {
  guildId: 'g1',
  current: {
    identifier: 'x',
    title: 'Eseekid Live',
    author: 'EsDeeKid',
    uri: 'https://youtube.com/watch?v=x',
    duration: 3600000,
    isSeekable: true,
    isStream: false,
    artworkUrl: 'https://cdn.example.com/video.jpg',
    source: 'youtube',
  },
  tracks: [],
  totalTracks: 0,
  totalDuration: 0,
  remainingDuration: 0,
  loopMode: 'off',
  volume: 100,
  isPaused: false,
  isPlaying: true,
  is247: false,
  autoplay: false,
  position: 200000,
} as never;

describe('buildNowPlayingResponse chapters', () => {
  const textsOf = (res: { toMessagePayload: () => unknown }): string[] => {
    const json = JSON.parse(JSON.stringify(res.toMessagePayload())) as {
      components?: Array<{ components?: Array<{ content?: string }> }>;
    };
    const out: string[] = [];
    for (const row of json.components ?? []) {
      for (const c of row.components ?? []) {
        if (typeof c.content === 'string') out.push(c.content);
      }
    }
    return out;
  };

  it('shows the chapter line and swaps the cover', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      npQueue,
      0xff0000,
      null,
      { title: 'Rottweiler', artworkUrl: 'https://cdn.example.com/rottweiler.jpg' },
    );
    const texts = textsOf(res);
    expect(texts.some((t) => t.includes('▶ **Rottweiler**'))).toBe(true);
    const json = JSON.stringify(res.toMessagePayload());
    expect(json).toContain('rottweiler.jpg');
  });

  it('keeps the video card untouched without a chapter', () => {
    const res = MusicBuilders.buildNowPlayingResponse(npQueue, 0xff0000, null, null);
    const texts = textsOf(res);
    expect(texts.some((t) => t.includes('▶'))).toBe(false);
    const json = JSON.stringify(res.toMessagePayload());
    expect(json).toContain('video.jpg');
  });
});
