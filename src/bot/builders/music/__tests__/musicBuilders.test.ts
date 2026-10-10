import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { fallbackRow, MusicBuilders, MUSIC_SOURCE_BADGES } from '@bot/builders/music/musicBuilders';
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
  /**
   * The header as the user reads it: markdown link syntax and the trailing
   * source badge stripped, separators left. Budget assertions run on THIS,
   * not on the raw description, which carries a URL and a badge.
   */
  const visibleHeaderOf = (res: unknown): string => {
    const first = embedDesc(res).split('\n')[0] ?? '';
    return first
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split(' • ')
      .filter((part) => !MUSIC_SOURCE_BADGES.youtube.includes(part))
      .join(' • ')
      .trim();
  };
  const queueWith = (over: Record<string, unknown>) => {
    const base = JSON.parse(JSON.stringify(npQueue)) as { current: Record<string, unknown> };
    Object.assign(base.current, over);
    return base as never;
  };

  it('clamps an over-budget title to the shared line budget in V2 and fallback', () => {
    const long = 'T'.repeat(100);
    const res = MusicBuilders.buildNowPlayingResponse(queueWith({ title: long }), 0xff0000, null, null);
    // 50 chars + '..' = the 52-char budget, suffix included.
    const want = `${'T'.repeat(50)}..`;
    expect(textsOf(res).some((t) => t.includes(want))).toBe(true);
    expect(embedDesc(res).includes(want)).toBe(true);
    expect(visibleHeaderOf(res).length).toBeLessThanOrEqual(52);
    // Without the clamp the full 100-char run survives; its absence is the mutation check.
    expect(embedDesc(res).includes('T'.repeat(59 + 2))).toBe(false);
  });

  it('budgets the JOINED header line, not each field alone', () => {
    // Long single artist still overflows the joined line. Both fields fit
    // any per-field cap, so only a joined budget shortens this. Truncated
    // on a word boundary with '..' (uppercase tail proves no mid-word slice).
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ title: 'WHAT TO DO? • JACKBOYS', author: 'JACKBOYS ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF' }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible.length).toBeLessThanOrEqual(52);
    expect(visible).toContain('WHAT TO DO?');
    expect(visible.endsWith('..')).toBe(true);
    expect(visible).not.toMatch(/[a-z]\.\.$/);
    expect(visible).not.toContain('FOXTROT');
  });

  it('shows exactly one artist: no feat, no collaborators, no album', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ title: 'WHAT TO DO? • JACKBOYS', author: 'JACKBOYS, Travis Scott, Don Toliver' }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible).toBe('WHAT TO DO? • JACKBOYS • JACKBOYS');
    expect(visible).not.toContain('Toliver');
    expect(visible).not.toContain('Travis');
    expect(visible).not.toContain(',');
  });

  it('keeps the title whole and spends what is left on the single artist', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ title: 'WHAT TO DO? • JACKBOYS', author: 'JACKBOYS, Travis Scott, Don Toliver' }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible.startsWith('WHAT TO DO? • JACKBOYS • JACKBOYS')).toBe(true);
  });

  it('never renders the album, even when the provider reports one', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({
        title: 'WHAT TO DO? • JACKBOYS',
        album: 'Love Sick',
        author: 'JACKBOYS, Travis Scott, Don Toliver',
      }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible.length).toBeLessThanOrEqual(52);
    expect(visible).not.toContain('Love Sick');
    expect(visible).toBe('WHAT TO DO? • JACKBOYS • JACKBOYS');
  });

  it('drops nothing when the header fits: title plus single artist only', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({
        title: 'WHAT TO DO? • JACKBOYS • JACKBOYS, Travis Scott',
        album: 'Love Sick Deluxe Edition',
        author: 'Don Toliver',
      }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible.length).toBeLessThanOrEqual(52);
    expect(visible).not.toContain('Deluxe Edition');
    expect(visible).not.toContain('Love Sick');
  });

  it('a short header renders title plus single artist in full, no album', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ title: 'Geronimo', album: 'Love Sick', author: 'Don Toliver' }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible).toBe('Geronimo • Don Toliver');
  });

  it('passes a title that fits the budget through untouched', () => {
    const exact = 'E'.repeat(48);
    const res = MusicBuilders.buildNowPlayingResponse(queueWith({ title: exact }), 0xff0000, null, null);
    expect(embedDesc(res).includes(`[${exact}]`)).toBe(true);
    expect(embedDesc(res)).not.toContain('..');
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

  it('keeps a long single artist inside the same budget, album ignored', () => {
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ album: 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India', author: 'JULIET KILO LIMA MIKE NOVEMBER OSCAR PAPA QUEBEC' }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible.length).toBeLessThanOrEqual(52);
    expect(visible.startsWith('Eseekid Live • JULIET')).toBe(true);
    // Album never renders, even when it is the longest field.
    expect(visible).not.toContain('Alpha');
    expect(visible).not.toContain('Foxtrot');
    // Word-boundary cut on the artist: tail gone.
    expect(visible).not.toContain('PAPA QUEBEC');
  });

  it('strips feat/with/and collaborators down to one artist name', () => {
    for (const [author, want] of [
      ['Don Toliver feat. Travis Scott', 'Don Toliver'],
      ['Don Toliver ft. Travis Scott', 'Don Toliver'],
      ['Don Toliver featuring Travis Scott', 'Don Toliver'],
      ['Don Toliver with Travis Scott', 'Don Toliver'],
      ['Travis Scott and Don Toliver', 'Travis Scott'],
      ['JACKBOYS, Travis Scott, Don Toliver', 'JACKBOYS'],
      ['JACKBOYS & Travis Scott', 'JACKBOYS'],
      ['Artist1 x Artist2', 'Artist1'],
      ['Artist1 vs Artist2', 'Artist1'],
      ['Don Toliver - Topic', 'Don Toliver'],
      ['Don Toliver VEVO', 'Don Toliver'],
    ] as Array<[string, string]>) {
      const res = MusicBuilders.buildNowPlayingResponse(queueWith({ title: 'T', author }), 0xff0000, null, null);
      const visible = visibleHeaderOf(res);
      expect(visible).toBe(`T • ${want}`);
    }
  });

  it('hard-splits an unbreakable run rather than exceeding the budget', () => {
    // A 100-char single "word" has no boundary to cut at, so it is sliced.
    // The budget still holds — that is the invariant that matters. Album is
    // ignored entirely, so only the artist run can overflow here.
    const res = MusicBuilders.buildNowPlayingResponse(
      queueWith({ album: 'A'.repeat(100), author: 'B'.repeat(100) }),
      0xff0000,
      null,
      null,
    );
    const visible = visibleHeaderOf(res);
    expect(visible.length).toBeLessThanOrEqual(52);
    expect(visible.endsWith('..')).toBe(true);
    expect(visible).not.toContain('A'.repeat(10));
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
