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

describe('Now Playing card text limits (58 + ...)', () => {
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
  const embedDesc = (res: unknown): string =>
    String((res as { embed: { data: { description?: string } } }).embed.data.description ?? '');
  const queueWith = (over: Record<string, unknown>) => {
    const base = JSON.parse(JSON.stringify(npQueue)) as { current: Record<string, unknown> };
    Object.assign(base.current, over);
    return base as never;
  };

  it('clamps a long title to 52 chars plus .. in V2 and fallback', () => {
    const long = 'T'.repeat(100);
    const res = MusicBuilders.buildNowPlayingResponse(queueWith({ title: long }), 0xff0000, null, null);
    const want = `${'T'.repeat(52)}..`;
    expect(textsOf(res).some((t) => t.includes(want))).toBe(true);
    expect(embedDesc(res).includes(want)).toBe(true);
    // Without the clamp the full 100-char run survives; its absence is the mutation check.
    expect(embedDesc(res).includes('T'.repeat(59 + 2))).toBe(false);
  });

  it('cuts the measured real title exactly where the card was too wide', () => {
    // From the 2026-10-03 card: this title ran the header long enough to
    // dominate the layout. 52 chars + '..' is the agreed cut point.
    const title = 'WHAT TO DO? • JACKBOYS • JACKBOYS, Travis Scott, Don Toliver';
    const res = MusicBuilders.buildNowPlayingResponse(queueWith({ title }), 0xff0000, null, null);
    expect(embedDesc(res)).toContain('[WHAT TO DO? • JACKBOYS • JACKBOYS, Travis Scott, Don..]');
    expect(embedDesc(res)).not.toContain('Don Toliver]');
  });

  it('passes an exact-52 title through untouched', () => {
    const exact = 'E'.repeat(52);
    const res = MusicBuilders.buildNowPlayingResponse(queueWith({ title: exact }), 0xff0000, null, null);
    expect(embedDesc(res).includes(`[${exact}]`)).toBe(true);
    expect(embedDesc(res).includes('..')).toBe(false);
  });

  it('leaves a short title untouched', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ title: 'Short Song' }),
      0xff0000,
      null,
      null,
    );
    expect(embedDesc(res).includes('[Short Song]')).toBe(true);
    expect(embedDesc(res).includes('...')).toBe(false);
  });

  it('still renders empty and whitespace titles without throwing', () => {
    for (const title of ['', '   ']) {
      let res: unknown = null;
      expect(() => {
        res = MusicBuilders.buildNowPlayingResponse(queueWith({ title }), 0xff0000, null, null);
      }).not.toThrow();
      // setTitle('') throws, but this card only uses setDescription/setContent,
      // so the artist and badge keep the card sendable.
      expect(embedDesc(res).includes('EsDeeKid')).toBe(true);
      expect(textsOf(res as { toMessagePayload: () => unknown }).join('\n').includes('EsDeeKid')).toBe(
        true,
      );
    }
  });

  it('wraps long lyric lines at word boundaries, never ...', () => {
    const longCur = `C ${'word '.repeat(30).trim()}`;
    const wrapped = MusicBuilders.buildLyricSection({ current: longCur, next: longCur });
    expect(wrapped).not.toContain('...');
    // Every visual line fits the 58 budget.
    for (const line of String(wrapped).replaceAll('*', '').split('\n')) {
      expect(line.length).toBeLessThanOrEqual(58);
    }
    // No-space run hard-splits at the budget.
    expect(MusicBuilders.buildLyricSection({ current: 'C'.repeat(100), next: null })).toBe(
      `**${'C'.repeat(58)}\n${'C'.repeat(42)}**`,
    );
    expect(MusicBuilders.buildLyricSection({ current: 'C'.repeat(100), next: null }, false)).toBe(
      `**${'C'.repeat(58)}\n${'C'.repeat(42)}**`,
    );
    // Without the wrap the 100-char run stays on one line; its absence is the mutation check.
    expect(MusicBuilders.buildLyricSection({ current: 'C'.repeat(100), next: null })).not.toContain(
      'C'.repeat(59),
    );
  });

  it('wraps the 59-char lyric example onto two lines, 58 untouched', () => {
    const line58 = "Tell me what's the price to pay the motherfuckin' preacher";
    expect(line58).toHaveLength(58);
    expect(MusicBuilders.buildLyricSection({ current: line58, next: null })).toBe(`**${line58}**`);
    expect(MusicBuilders.buildLyricSection({ current: `${line58}!`, next: null })).toBe(
      "**Tell me what's the price to pay the motherfuckin'\npreacher!**",
    );
  });

  it('returns null when the lyric window is null', () => {
    expect(MusicBuilders.buildLyricSection(null)).toBeNull();
    expect(MusicBuilders.buildLyricSection({ current: null, next: null })).toBeNull();
  });

  it('clamps long album and artist parts of the header', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ album: 'A'.repeat(100), author: 'B'.repeat(100) }),
      0xff0000,
      null,
      null,
    );
    expect(embedDesc(res).includes(`${'A'.repeat(58)}...`)).toBe(true);
    expect(embedDesc(res).includes(`${'B'.repeat(58)}...`)).toBe(true);
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
