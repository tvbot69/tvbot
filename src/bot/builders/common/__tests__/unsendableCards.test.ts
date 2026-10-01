import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { TrackBuilders } from '@bot/builders/library/trackBuilders';
import { PlaycountBuilders } from '@bot/builders/library/playcountBuilders';
import { MusicBuilders } from '@bot/builders/music/musicBuilders';
import { DiscogsAndImportBuilders } from '@bot/builders/apple/discogsAndImportBuilders';
import { WhoKnowsBuilders } from '@bot/builders/whoknows/whoKnowsBuilders';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import type { ContextModel } from '@bot/models/contextModel';
import type { VideoChapter } from '@bot/services/music/videoChapters';
import type { GuildLeaderboardEntry } from '@bot/services/library/playHistoryService';

/**
 * Five unsendable-card defects, all the same mechanism.
 *
 * `TextDisplayBuilder.setContent('')` and `EmbedBuilder.setDescription('')` both
 * reject an empty string, so a builder that can hand one of them an empty string
 * does not render a blank card — it throws, and the message is never sent. Each
 * case below is a value the declared parameter type accepts.
 *
 * The loved-tracks case is the only one that is a *reachable* production path
 * rather than a latent one, and it is also the one that rendered a claim the
 * data did not support: "Page 10000/5".
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const context = { discordUserId: '1', accentColor: 0x112233 } as ContextModel;

describe('TrackBuilders.buildLovedTracksResponse: the page exists', () => {
  const item = (name: string) => ({ name, artistName: 'Aphex Twin' });

  it('clamps a page index past the end instead of printing "Page 10000/5"', () => {
    // `nowPlayingInteractions.ts:213` computes `newPage = currentPage + 1` with
    // no upper bound, and the total comes fresh from Last.fm, so a count that
    // shrank since the card was rendered puts the index past the end.
    const text = body(
      TrackBuilders.buildLovedTracksResponse(
        'alice',
        'Alice',
        Array.from({ length: 5 }, (_, i) => item(`t${i}`)),
        9999,
        5,
      ),
    );
    expect(text).not.toContain('Page 10000/5');
    expect(text).toContain('Page 1/1');
  });

  it('never prints more pages than exist, for any index', () => {
    // The claim is "Page C/T", and a card may only print it when C <= T.
    for (const index of [-5, 0, 1, 2, 50, 9999]) {
      const text = body(
        TrackBuilders.buildLovedTracksResponse(
          'alice',
          'Alice',
          Array.from({ length: 5 }, (_, i) => item(`t${i}`)),
          index,
          5,
        ),
      );
      const match = /Page (\d+)\/(\d+)/.exec(text);
      expect(match, `no page footer for index ${index}`).not.toBeNull();
      const current = Number(match![1]);
      const total = Number(match![2]);
      expect(current, `index ${index} printed Page ${current}/${total}`).toBeLessThanOrEqual(total);
    }
  });

  it('clamps a negative page index to the first page', () => {
    const text = body(TrackBuilders.buildLovedTracksResponse('alice', 'Alice', [item('t0')], -3, 1));
    expect(text).toContain('Page 1/1');
  });

  it('agrees the noun with a total of one', () => {
    const text = body(TrackBuilders.buildLovedTracksResponse('alice', 'Alice', [item('t0')], 0, 1));
    expect(text).toContain('1 loved track');
    expect(text).not.toContain('1 loved tracks');
  });
});

describe('PlaycountBuilders.buildLeaderboardResponse: an out-of-range index is not fatal', () => {
  const entry = (name: string): GuildLeaderboardEntry =>
    ({ userNameLastFm: name, displayName: name, value: 42 }) as GuildLeaderboardEntry;

  const card = (entries: GuildLeaderboardEntry[], pageIndex?: number) =>
    PlaycountBuilders.buildLeaderboardResponse({
      guildName: 'G',
      title: 'Scrobbles',
      unit: 'plays',
      entries,
      pageIndex,
    });

  it('renders the first page for a negative index instead of throwing', () => {
    // Unclamped, `slice(-10, 0)` is empty, `listText` is `''`, and
    // `setContent('')` threw — the leaderboard could not be sent at all.
    const response = card([entry('alice'), entry('bob')], -1);
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('alice');
  });

  it('renders the last page for an index past the end instead of throwing', () => {
    const response = card([entry('alice'), entry('bob')], 99);
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('bob');
  });

  it('never claims a page that does not exist', () => {
    const text = body(card([entry('alice'), entry('bob')], 99));
    expect(text).not.toContain('Page 100 of 1');
  });
});

describe('MusicBuilders: an empty input must not cost the card', () => {
  const chapters: VideoChapter[] = [
    { title: 'Intro', startMs: 0 },
    { title: 'Verse', startMs: 1000 },
  ];

  it('renders a chapters card for an empty chapter list instead of throwing', () => {
    const response = MusicBuilders.buildChaptersResponse(
      { title: 'Xtal', author: 'Aphex Twin', uri: 'https://youtu.be/dQw4w9WgXcQ' },
      [],
      0,
    );
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
  });

  it('agrees the noun with a single chapter', () => {
    const response = MusicBuilders.buildChaptersResponse(
      { title: 'Xtal', author: 'Aphex Twin', uri: 'https://youtu.be/dQw4w9WgXcQ' },
      chapters.slice(0, 1),
      0,
    );
    expect(body(response)).toContain('1 chapter');
    expect(body(response)).not.toContain('1 chapters');
  });

  it('still says "chapters" for two', () => {
    const response = MusicBuilders.buildChaptersResponse(
      { title: 'Xtal', author: 'Aphex Twin', uri: 'https://youtu.be/dQw4w9WgXcQ' },
      chapters,
      0,
    );
    expect(body(response)).toContain('2 chapters');
  });

  it('renders a simple response for an empty title instead of throwing', () => {
    // `EmbedBuilder.setTitle('')` and `setContent('')` both throw, so a blank
    // title was an unsendable card rather than a blank one.
    const response = MusicBuilders.buildSimpleResponse('');
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(() => response.embed.toJSON()).not.toThrow();
  });
});

describe('TrackBuilders.buildTrackLyricsResponse: an empty body still sends', () => {
  it('renders a notice when the provider returns no lyrics', () => {
    const response = TrackBuilders.buildTrackLyricsResponse('Xtal', 'Aphex Twin', '');
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('No lyrics were returned');
  });
});

describe('DiscogsAndImportBuilders: an empty instruction body still sends', () => {
  it('renders a notice for an empty instruction string', () => {
    const response = DiscogsAndImportBuilders.buildImportInstructionsResponse({ instructions: '' });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('No import instructions');
  });
});

describe('WhoKnowsBuilders: an empty list still sends in the default embed mode', () => {
  it('renders a default-mode card when the listener list comes back empty', async () => {
    // `EmbedBuilder.setDescription('')` throws, so an empty leaderboard took the
    // whole card down rather than rendering it.
    const response = await WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      'Aphex Twin',
      'https://www.last.fm/music/Aphex+Twin',
      null,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      WhoKnowsMode.Default,
    );
    expect(() => response.embed.toJSON()).not.toThrow();
  });
});