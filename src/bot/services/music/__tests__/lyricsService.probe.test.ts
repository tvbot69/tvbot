import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LyricsService, type LyricsResult } from '@bot/services/music/lyricsService';

/**
 * `LyricsService` — 178 of 200 lines uncovered, and entirely untested.
 *
 * The whole file is one rule wearing four provider legs:
 *
 * > **"This song has no lyrics" is a FACT only when a provider actually said
 * > so. A provider that timed out, returned 503, or was rate-limited said
 * > nothing about the song.**
 *
 * That is the A1 rule applied to lyrics, and it is easy to get wrong in the
 * direction that reads well: a negative cache entry written from a run where
 * every leg failed makes the bot tell every listener "no lyrics" for an HOUR
 * after a ten-second blip. The `probe.answered` flag is the whole fix, and it
 * is invisible unless you test it — so every failure status is tested in BOTH
 * directions here:
 *
 *  - a 404 / 410 DOES authorise the negative entry (a real answer), and
 *  - a 503 / 429 / 500 / 401 / 403 / transport throw does NOT.
 *
 * The second half of the file pins the rung ORDER and the shape of what comes
 * back, because a rung that answers with the wrong song's lyrics is the same
 * class of bug as a wrong preview: a confident falsehood on a card.
 *
 * `LyricsService` is `@singleton()` but is constructed directly here, which is
 * what the decorator permits and what keeps the cache per-test.
 */

let fetchMock: ReturnType<typeof vi.fn>;

const svc = () => new LyricsService();

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const LRCLIB_ROW = {
  trackName: 'Airbag',
  artistName: 'Radiohead',
  plainLyrics: 'Anyone here who ever drifted off alone in a car?',
  syncedLyrics: '[00:00.00]Anyone here who ever drifted off alone',
  duration: 284,
};

/** Answers every LRCLIB/Genius request as "nothing here", status configurable. */
const allMiss = (status = 404) => {
  fetchMock.mockResolvedValue(json({}, status));
};

const geniusHtml = (chunks: string[]) =>
  `<html><body>${chunks
    .map((c) => `<div class="Lyrics__Container" data-lyrics-container="true">${c}</div>`)
    .join('')}<span>5Embed</span></body></html>`;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe('getLyrics — a definitive 404 DOES authorise the negative cache entry', () => {
  it('a 404 from LRCLIB is cached, and the second call asks nobody', async () => {
    allMiss(404);
    const s = svc();

    await expect(s.getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await expect(s.getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();

    // A real "no such track" from the vendor IS a fact and is worth an hour.
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('a 410 is an answer too, because it is the same statement as a 404', async () => {
    allMiss(410);
    const s = svc();
    await s.getLyrics('Gone', 'Nobody');
    const after = fetchMock.mock.calls.length;
    await s.getLyrics('Gone', 'Nobody');
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it('a 404 that appears only on the LAST leg still authorises it, because it was still a real answer', async () => {
    // Genius is the last thing asked, so a Genius 404 is the whole verdict.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('lrclib.net')) return json({}, 503);
      return json({ response: { sections: [] } }, 404);
    });
    const s = svc();

    await expect(s.getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
    const after = fetchMock.mock.calls.length;
    await s.getLyrics('Airbag', 'Radiohead');
    expect(fetchMock.mock.calls.length).toBe(after);
  });
});

describe('getLyrics — an inconclusive leg must NOT be cached as "no lyrics"', () => {
  it.each([
    ['503 ServerOverloaded', 503],
    ['429 rate limited', 429],
    ['500 internal error', 500],
    ['401 unauthorised', 401],
    ['403 forbidden', 403],
  ])('a %s re-asks on the next call instead of freezing the answer', async (_label, status) => {
    // The bug this rule prevents, measured: LRCLIB answers 503 roughly one time
    // in eight with no provocation. Caching from that run told everyone "no
    // lyrics" for an hour.
    allMiss(status);
    const s = svc();

    await expect(s.getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
    const afterFirst = fetchMock.mock.calls.length;

    await expect(s.getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();

    // Every leg asked again — the provider was never asked about the song.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('a transport throw re-asks, because nothing was ever said about the track', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const s = svc();

    await expect(s.getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
    const afterFirst = fetchMock.mock.calls.length;
    await s.getLyrics('Airbag', 'Radiohead');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('a positive result IS cached, so a resolved track is fetched once', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(LRCLIB_ROW);
      return json({}, 404);
    });
    const s = svc();

    const first = await s.getLyrics('Airbag', 'Radiohead');
    const after = fetchMock.mock.calls.length;
    const second = await s.getLyrics('Airbag', 'Radiohead');

    expect(first?.plainLyrics).toBe(LRCLIB_ROW.plainLyrics);
    expect(second).toEqual(first);
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it('an EXPIRED entry re-fetches, so a fixed provider heals without a restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(LRCLIB_ROW);
      return json({}, 404);
    });
    const s = svc();
    await s.getLyrics('Airbag', 'Radiohead');
    const afterFirst = fetchMock.mock.calls.length;

    // Just inside the hour: still cached.
    vi.advanceTimersByTime(59 * 60_000);
    await s.getLyrics('Airbag', 'Radiohead');
    expect(fetchMock.mock.calls.length).toBe(afterFirst);

    // Past it: asked again.
    vi.advanceTimersByTime(2 * 60_000);
    await s.getLyrics('Airbag', 'Radiohead');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe('getLyrics — the rung order, and which rung answered', () => {
  it('an EXACT LRCLIB hit stops the walk, so no needless Genius scrape', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(LRCLIB_ROW);
      return json({}, 404);
    });

    const res = await svc().getLyrics('Airbag', 'Radiohead');

    expect(res?.source).toBe('lrclib');
    expect(urls().some((u) => u.includes('genius.com'))).toBe(false);
  });

  it('skips the exact leg entirely when there is no artist, rather than asking with an empty parameter', async () => {
    allMiss(404);
    const res = await svc().getLyrics('Airbag');

    expect(res).toBeNull();
    // An `artist_name=` blank would be a query LRCLIB cannot match anyway.
    expect(urls().some((u) => u.includes('artist_name='))).toBe(false);
  });

  it('falls to the LRCLIB SEARCH when the exact leg misses', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({}, 404);
      if (url.includes('/api/search')) return json([LRCLIB_ROW]);
      return json({}, 404);
    });

    const res = await svc().getLyrics('Airbag', 'Radiohead');

    expect(res?.plainLyrics).toBe(LRCLIB_ROW.plainLyrics);
    expect(res?.source).toBe('lrclib');
  });

  it('prefers a row that actually HAS lyrics over the first row', async () => {
    // A search returns closest-match first, and LRCLIB routinely leads with a
    // row carrying no `plainLyrics` at all. Taking row 0 would answer "no
    // lyrics" for a song that has them.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({}, 404);
      if (url.includes('/api/search')) {
        return json([{ trackName: 'Empty Row', artistName: 'X' }, { ...LRCLIB_ROW, plainLyrics: '   ' }, LRCLIB_ROW]);
      }
      return json({}, 404);
    });

    const res = await svc().getLyrics('Airbag', 'Radiohead');

    expect(res?.plainLyrics).toBe(LRCLIB_ROW.plainLyrics);
  });

  it('accepts an INSTRUMENTAL row from search, because a miss there is not "no lyrics"', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({}, 404);
      if (url.includes('/api/search')) return json([{ trackName: 'X', artistName: 'Y', instrumental: true }]);
      return json({}, 404);
    });

    const res = await svc().getLyrics('Ambient Piece', 'Someone');

    expect(res?.instrumental).toBe(true);
    expect(res?.plainLyrics).toMatch(/instrumental/i);
  });

  it('falls to Genius when LRCLIB is exhausted, and reports the provider it came from', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('lrclib.net')) return json({}, 404);
      if (url.includes('genius.com/api/search')) {
        return json({
          response: {
            sections: [
              { type: 'top_hit', hits: [{ result: { title: 'Wrong', artist_names: 'N', url: 'https://genius.test/wrong' } }] },
              { type: 'song', hits: [{ result: { title: 'Airbag', artist_names: 'Radiohead', url: 'https://genius.test/airbag' } }] },
            ],
          },
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => geniusHtml(['Anyone here who ever drifted off alone in a car']),
      };
    });

    const res = await svc().getLyrics('Airbag', 'Radiohead');

    expect(res?.source).toBe('genius');
    // Only the `song` section is a song page; a `top_hit` is an article.
    expect(res?.title).toBe('Airbag');
    expect(res?.plainLyrics).toContain('Anyone here who ever drifted off alone');
  });

  it('retries Genius with the TITLE ALONE, because an artist string can be what does not match', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('lrclib.net')) return json({}, 404);
      if (url.includes('genius.com/api/search')) return json({ response: { sections: [] } });
      return json({}, 404);
    });

    await svc().getLyrics('Bohemian Rhapsody', 'Queen');

    const geniusCalls = urls().filter((u) => u.includes('genius.com/api/search'));
    // Combined first, then title only.
    expect(geniusCalls).toHaveLength(2);
    expect(geniusCalls[0]).toContain('Queen');
    expect(geniusCalls[1]).not.toContain('Queen');
  });

  it('does NOT ask Genius twice when there is no artist, because the two queries are identical', async () => {
    allMiss(404);
    await svc().getLyrics('Airbag');
    expect(urls().filter((u) => u.includes('genius.com/api/search'))).toHaveLength(1);
  });

  it('a Genius page with no lyrics container is null, not an empty lyric sheet', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('genius.com/api/search')) {
        return json({ response: { sections: [{ type: 'song', hits: [{ result: { title: 'Airbag', artist_names: 'Radiohead', url: 'https://genius.test/a' } }] }] } });
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<html>nothing</html>' };
    });

    await expect(svc().getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
  });

  it('a Genius page whose scrape is too short to be lyrics is null, rather than a stub', async () => {
    // 20 characters is the floor. Below it, what came back is a heading or an
    // embed artifact, and rendering it as the song's lyrics is a wrong card.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('genius.com/api/search')) {
        return json({ response: { sections: [{ type: 'song', hits: [{ result: { title: 'Airbag', artist_names: 'Radiohead', url: 'https://genius.test/a' } }] }] } });
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => geniusHtml(['Too short']) };
    });

    await expect(svc().getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
  });

  it('strips markup, joins containers with blank lines, and drops the embed counter', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('genius.com/api/search')) {
        return json({ response: { sections: [{ type: 'song', hits: [{ result: { title: 'Airbag', artist_names: 'Radiohead', url: 'https://genius.test/a' } }] }] } });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => geniusHtml(['First <a href="/x">linked</a> line<br>second line', 'Third container line']),
      };
    });

    const res = await svc().getLyrics('Airbag', 'Radiohead');

    expect(res?.plainLyrics).toBe('First linked line\nsecond line\n\nThird container line');
  });

  it('a Genius search with no `song` section is null, not the top hit', async () => {
    // Genius's multi-search leads with a `top_hit` section that is frequently an
    // ANNOTATION. Scraping that is a confident wrong answer.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('genius.com/api/search')) {
        return json({ response: { sections: [{ type: 'top_hit', hits: [{ result: { title: 'Annotated', artist_names: 'X', url: 'https://genius.test/notes' } }] }] } });
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => geniusHtml(['Some long enough annotation text here']) };
    });

    await expect(svc().getLyrics('Airbag', 'Radiohead')).resolves.toBeNull();
  });
});

describe('mapToLyricsResult — what a caller is actually handed', () => {
  const throughSearch = async (row: unknown): Promise<LyricsResult | null> => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({}, 404);
      if (url.includes('/api/search')) return json([row]);
      return json({}, 404);
    });
    return new LyricsService().getLyrics('Airbag', 'Radiohead');
  };

  it('converts the provider duration from SECONDS to milliseconds', async () => {
    // Handing 284 through as ms would make the karaoke card think the track is
    // a quarter of a second long.
    const res = await throughSearch(LRCLIB_ROW);
    expect(res?.durationMs).toBe(284_000);
  });

  it('omits durationMs when the provider sent none, rather than claiming zero', async () => {
    const res = await throughSearch({ ...LRCLIB_ROW, duration: undefined });
    expect(res?.durationMs).toBeUndefined();
  });

  it('omits durationMs when the provider sent zero', async () => {
    // Zero is not a track length, and 0 in a duration check means "unknown".
    const res = await throughSearch({ ...LRCLIB_ROW, duration: 0 });
    expect(res?.durationMs).toBeUndefined();
  });

  it('names the track and artist as Unknown rather than leaving them blank', async () => {
    const res = await throughSearch({ plainLyrics: 'x' });
    expect(res?.title).toBe('Unknown Title');
    expect(res?.artist).toBe('Unknown Artist');
  });

  it('a row with no lyrics and no instrumental flag is null, not an empty lyric sheet', async () => {
    await expect(throughSearch({ trackName: 'X', artistName: 'Y' })).resolves.toBeNull();
  });

  it('trimmed lyrics keep their content, and blank synced text is left empty rather than undefined', async () => {
    const res = await throughSearch({ ...LRCLIB_ROW, plainLyrics: '  real text  ', syncedLyrics: '   ' });
    expect(res?.plainLyrics).toBe('real text');
    // `''`, not `undefined`: the field was PRESENT and empty, and the karaoke
    // guard's `parseLrc` handles both the same way. Worth stating so a change
    // here is a visible change to this test.
    expect(res?.syncedLyrics).toBe('');
  });
});

describe('cleanSearchQuery — the cruft stripper the search is built on', () => {
  const s = svc();

  it('drops the artist prefix from the title when they are the same string', () => {
    // Upload titles are almost always "Artist - Title"; leaving both in makes
    // every query "Radiohead Airbag Radiohead - Airbag".
    expect(s.cleanSearchQuery('Radiohead - Airbag', 'Radiohead').cleanTitle).toBe('Airbag');
  });

  it('drops a `- Topic` suffix and a VEVO suffix from the artist', () => {
    expect(s.cleanSearchQuery('Airbag', 'Radiohead - Topic').cleanArtist).toBe('Radiohead');
    expect(s.cleanSearchQuery('Airbag', 'RadioheadVEVO').cleanArtist).toBe('Radiohead');
  });

  it('strips a bracketed noise tag such as (Official Video) or [Remastered]', () => {
    expect(s.cleanSearchQuery('Airbag (Official Video)', 'Radiohead').cleanTitle).toBe('Airbag');
    expect(s.cleanSearchQuery('Airbag [Remastered 2016]', 'Radiohead').cleanTitle).toBe('Airbag');
  });

  it('strips a trailing feature credit when it is not inside brackets', () => {
    expect(s.cleanSearchQuery('Airbag feat. Someone', 'Radiohead').cleanTitle).toBe('Airbag');
  });

  it('strips a bracketed feature credit WHOLE, so no dangling "(" survives into the query', () => {
    // `feat.` was missing from the bracketed-noise list, so `(feat. Someone)`
    // matched nothing there. The bare-feature strip then ran and removed
    // everything from `feat.` to the end of the string — closer and all — and
    // left the opener behind, so the search went out for `Radiohead Airbag (`,
    // a title no provider has. The bracket and its contents are one unit.
    const res = s.cleanSearchQuery('Airbag (feat. Someone)', 'Radiohead');
    expect(res.cleanTitle).toBe('Airbag');
    // Stated as the consequence, because that is what the user experiences.
    expect(res.combined).toBe('Radiohead Airbag');
  });

  it('strips every credit word in brackets, not just the "feat." spelling', () => {
    // The three spellings are one rule. Fixing only `feat.` would leave
    // `(ft. X)` and `(featuring X)` producing the same unmatchable query.
    for (const title of ['Airbag (feat. Someone)', 'Airbag (ft. Someone)', 'Airbag (featuring Someone)', 'Airbag [feat. Someone]']) {
      expect(s.cleanSearchQuery(title, 'Radiohead').cleanTitle).toBe('Airbag');
    }
  });

  it('a credit and a bracketed noise tag together still leave a clean title', () => {
    // Both strips have to survive each other, in either order. The bare
    // credit comes first in one and second in another, and the bracketed credit
    // is removed by the SAME global pass as the noise tag beside it — which is
    // why this is a `g` regex and not a single-tag strip.
    expect(s.cleanSearchQuery('Creepin ft. 21 Savage (Remastered 4K)', 'Metro Boomin').cleanTitle).toBe('Creepin');
    expect(s.cleanSearchQuery('Airbag (Official Video) feat. Someone', 'Radiohead').cleanTitle).toBe('Airbag');
    expect(s.cleanSearchQuery('Airbag (Official Video) (feat. Someone)', 'Radiohead').cleanTitle).toBe('Airbag');
  });

  it('removes the CREDIT bracket only, leaving a qualifier that follows it intact', () => {
    // This is the test that says WHERE the credit is removed. Scrubbing a
    // dangling trailing bracket instead gives `Airbag` here, which silently
    // throws away `(Remix)` — a different recording, and one whose words are
    // not the original's. A credit is noise; a remix qualifier is the name.
    expect(s.cleanSearchQuery('Airbag (feat. Someone) (Remix)', 'Radiohead').cleanTitle).toBe('Airbag (Remix)');
    expect(s.cleanSearchQuery('Airbag (feat. Someone) (Live)', 'Radiohead').cleanTitle).toBe('Airbag (Live)');
  });

  it('removes an UNMATCHED trailing bracket left by a truncated upload title', () => {
    // YouTube truncates titles at 100 characters, which routinely cuts the
    // closer off: `Creepin (feat. 21 Savage`. Neither strip can consume a
    // bracket with no end, so the feature strip leaves `Creepin (` — the same
    // guaranteed miss, from a shape that also occurs in the wild.
    expect(s.cleanSearchQuery('Creepin (feat. 21 Savage', 'Metro Boomin').cleanTitle).toBe('Creepin');
    expect(s.cleanSearchQuery('Airbag [ft. Someone', 'Radiohead').cleanTitle).toBe('Airbag');
  });

  it('keeps a bracket that GENUINELY closes the title, because that is part of the name', () => {
    // The counterpart of the case above. A cleaner that deletes any trailing
    // bracket group mangles a real title, which is as bad as one that leaves
    // noise: `Exit Music (For a Film)` is not `Exit Music`.
    expect(s.cleanSearchQuery('Exit Music (For a Film)', 'Radiohead').cleanTitle).toBe('Exit Music (For a Film)');
    expect(s.cleanSearchQuery('Sparks (2017)', 'Coldplay').cleanTitle).toBe('Sparks (2017)');
    // A remix is a different recording, often with different words — the
    // qualifier stays in the query, like `(Live)` or `(Acoustic)` would.
    expect(s.cleanSearchQuery('Airbag (Remix)', 'Radiohead').cleanTitle).toBe('Airbag (Remix)');
  });

  it('never ends a cleaned title on an unmatched bracket, for any of those shapes', () => {
    const titles = [
      'Airbag',
      'Airbag (feat. Someone)',
      'Airbag (ft. Someone)',
      'Airbag (featuring Someone)',
      'Airbag (feat. Someone',
      'Airbag [Remastered 2016]',
      'Airbag (Remastered)',
      'Airbag (Official Video)',
      'Airbag feat. Someone',
      'Airbag (Remix)',
      'Exit Music (For a Film)',
      'Sparks (2017)',
    ];
    for (const title of titles) {
      expect(s.cleanSearchQuery(title, 'Radiohead').cleanTitle).not.toMatch(/[([]$/);
    }
  });

  it('treats a title with regex metacharacters in the artist as literal, not as a pattern', () => {
    // The artist is interpolated into a `new RegExp`; without escaping, `AC/DC`
    // or `A+` changes the pattern (or throws) instead of matching literally.
    expect(() => s.cleanSearchQuery('AC/DC - T.N.T.', 'AC/DC')).not.toThrow();
    expect(s.cleanSearchQuery('AC/DC - T.N.T.', 'AC/DC').cleanTitle).toBe('T.N.T.');
    // A `+` in the artist must not turn the preceding character into a
    // quantifier: `^A+\s*-\s*` would also eat an "Ax - " prefix it should not.
    expect(s.cleanSearchQuery('Ax - Song', 'A+').cleanTitle).toBe('Ax - Song');
  });

  it('leaves an ordinary title completely alone', () => {
    const res = s.cleanSearchQuery('Bohemian Rhapsody', 'Queen');
    expect(res).toEqual({ cleanTitle: 'Bohemian Rhapsody', cleanArtist: 'Queen', combined: 'Queen Bohemian Rhapsody' });
  });

  it('a title that is ONLY noise falls back to the raw title rather than becoming empty', () => {
    // An empty query is a guaranteed miss on every provider.
    expect(s.cleanSearchQuery('(Official Video)').cleanTitle).toBe('(Official Video)');
  });

  it('with no artist the combined query is the bare title', () => {
    expect(s.cleanSearchQuery('Airbag').combined).toBe('Airbag');
  });

  it('cleanTitle is the one-argument convenience form', () => {
    expect(s.cleanTitle('Radiohead - Airbag')).toBe('Radiohead - Airbag');
  });
});

describe('the cache is bounded, because an unbounded one is a memory leak', () => {
  it('evicts the oldest entry past 200 tracks, so a long session does not grow without limit', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(LRCLIB_ROW);
      return json({}, 404);
    });
    const s = svc();

    // 250 distinct tracks, one answer each.
    for (let i = 0; i < 250; i++) await s.getLyrics(`Track ${i}`, `Artist ${i}`);

    const cache = (s as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBeLessThanOrEqual(201);
    // The key is `artist:title`, both lower-cased.
    expect(cache.has('artist 249:track 249')).toBe(true);
    expect(cache.has('artist 0:track 0')).toBe(false);
  });
});

describe('getSyncedLyrics — the karaoke guards, not just the fetch', () => {
  const withLrc = (synced: string, extra: Record<string, unknown> = {}) => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({ ...LRCLIB_ROW, ...extra, syncedLyrics: synced });
      return json({}, 404);
    });
  };

  it('returns timed lines for a matching track', async () => {
    withLrc('[00:00.00]First\n[00:05.50]Second');
    const lines = await svc().getSyncedLyrics('Airbag', 'Radiohead', 284_000);

    expect(lines).toEqual([
      { ms: 0, text: 'First' },
      { ms: 5500, text: 'Second' },
    ]);
  });

  it('refuses WRONG-VERSION timings, because lyrics that arrive late are worse than none', async () => {
    // A 3-minute live of a 5-minute studio track shares the title and the
    // lyrics but not the clock.
    withLrc('[00:00.00]First', { duration: 180 });
    await expect(svc().getSyncedLyrics('Airbag', 'Radiohead (Live)', 300_000)).resolves.toBeNull();
  });

  it('accepts timings within the tolerance, because rounding is not a wrong version', async () => {
    withLrc('[00:00.00]First', { duration: 284 });
    await expect(svc().getSyncedLyrics('Airbag', 'Radiohead', 285_000)).resolves.not.toBeNull();
  });

  it('an instrumental track has nothing to sing, so it is null', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({ trackName: 'Ambient', artistName: 'A', instrumental: true });
      return json({}, 404);
    });
    await expect(svc().getSyncedLyrics('Ambient', 'A', 100_000)).resolves.toBeNull();
  });

  it('plain lyrics with no LRC timing are null, because a karaoke card needs a clock', async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json({ ...LRCLIB_ROW, syncedLyrics: undefined });
      return json({}, 404);
    });
    await expect(svc().getSyncedLyrics('Airbag', 'Radiohead', 284_000)).resolves.toBeNull();
  });

  it('no lyrics at all is null, never a throw', async () => {
    allMiss(404);
    await expect(svc().getSyncedLyrics('Nothing', 'Nobody', 100_000)).resolves.toBeNull();
  });
});
