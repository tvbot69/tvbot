import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { fallbackRow, MusicBuilders } from '@bot/builders/music/musicBuilders';
import { REPO_ROOT } from '../../../../testSupport/repoRoot';

describe('buildLyricSection', () => {
  it('renders current plus next line', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: 'Is it me' })).toBe(
      '**Hello**\nIs it me',
    );
  });

  it('omits the next line when the song ends', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Goodbye', next: null })).toBe('**Goodbye**');
  });

  it('shows the upcoming line before the first timestamp', () => {
    expect(MusicBuilders.buildLyricSection({ current: null, next: 'Hello' })).toBe('*Hello*');
  });

  it('returns null when nothing is singable', () => {
    expect(MusicBuilders.buildLyricSection(null)).toBeNull();
    expect(MusicBuilders.buildLyricSection({ current: null, next: null })).toBeNull();
  });

  it('renders embed-safe markdown for the legacy fallback', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: 'Is it me' }, false)).toBe(
      '**Hello**\n*Is it me*',
    );
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: null }, false)).toBe('**Hello**');
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
    expect(texts.some((t) => t.includes('Live — **Rottweiler**'))).toBe(true);
    const json = JSON.stringify(res.toMessagePayload());
    expect(json).toContain('rottweiler.jpg');
  });

  it('keeps the video card untouched without a chapter', () => {
    const res = MusicBuilders.buildNowPlayingResponse(npQueue, 0xff0000, null, null);
    const texts = textsOf(res);
    expect(texts.some((t) => t.includes('Live —'))).toBe(false);
    const json = JSON.stringify(res.toMessagePayload());
    expect(json).toContain('video.jpg');
  });

  it('renders chapter and lyrics together, chapter line before the lyric section', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      npQueue,
      0xff0000,
      { current: 'Hello', next: 'Is it me' },
      { title: 'Rottweiler', artworkUrl: 'https://cdn.example.com/rottweiler.jpg' },
    );
    const texts = textsOf(res);
    const chapterIdx = texts.findIndex((t) => t.includes('Live — **Rottweiler**'));
    const lyricIdx = texts.findIndex((t) => t.includes('**Hello**'));
    expect(chapterIdx).toBeGreaterThan(-1);
    expect(lyricIdx).toBeGreaterThan(chapterIdx);
    const embed = (res as unknown as { embed: { data: { description?: string } } }).embed;
    expect(String(embed.data.description)).toContain('Live — **Rottweiler**');
    expect(String(embed.data.description)).toContain('**Hello**');
  });

  it('trims bracket junk from the displayed title', () => {
    const longQueue = JSON.parse(JSON.stringify(npQueue)) as { current: { title: string } };
    longQueue.current.title = 'EsDeeKid - Live at Silver Spring, MD [FULL SET | 9/13/26]';
    const res = MusicBuilders.buildNowPlayingResponse(longQueue as never, 0xff0000, null, null);
    const texts = textsOf(res);
    expect(texts.some((t) => t.includes('EsDeeKid - Live at Silver Spring, MD'))).toBe(true);
    expect(texts.some((t) => t.includes('FULL SET'))).toBe(false);
  });
});

describe('fallbackRow helper', () => {
  it('carries button components into a fallback-compatible row', () => {
    const row = fallbackRow(
      new ButtonBuilder().setCustomId('a').setLabel('A').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('b').setLabel('B').setStyle(ButtonStyle.Primary),
    );
    expect(row.components).toHaveLength(2);
  });

  it('carries a select menu into the same row type, so V2 and fallback share one instance', () => {
    const row = fallbackRow(
      new StringSelectMenuBuilder().setCustomId('sel').setPlaceholder('Pick...').addOptions([
        { label: 'One', value: '1' },
      ]),
    );
    expect(row.components).toHaveLength(1);
    // The same instance serves both consumers: V2 container and legacy rows.
    const v2 = MusicBuilders.buildSearchResponse('q', [
      {
        identifier: 'id1',
        title: 'T',
        author: 'A',
        uri: 'https://youtube.com/watch?v=abcdefghijk',
        duration: 1000,
        isSeekable: true,
        isStream: false,
        source: 'youtube',
      } as never,
    ]);
    expect(v2.buildComponents().length).toBeGreaterThan(0);
  });
});

describe('fallback row invariant (9 sites move together)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bot', 'builders', 'music', 'musicBuilders.ts'), 'utf8');

  it('contains no as unknown as ActionRowBuilder cast', () => {
    expect(src).not.toMatch(/as unknown as ActionRowBuilder/);
  });

  it('routes all 9 fallback rows through the single helper', () => {
    // 9 call sites: now-playing, queue pagination, queue actions, queue
    // remove-menu, search select, search cancel, chapters (loop body counts
    // once in source), filters select, filters reset. A tenth row built any
    // other way fails here on purpose.
    const helperUses = [...src.matchAll(/(?<!\.)\bfallbackRow\(/g)];
    expect(helperUses).toHaveLength(9);
    const legacyAdds = [...src.matchAll(/\.addButtonRow\(/g)];
    expect(legacyAdds).toHaveLength(9);
  });
});
