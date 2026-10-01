import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';

/**
 * lastFmRepository is the largest untested file in the repo at 8.9% of 654
 * lines, and it is the main way data enters the system. These are
 * CHARACTERISATION tests: they pin the current behaviour of the paths that
 * matter, using a payload shape captured from the live API rather than one
 * invented to match the code.
 *
 * WHY A CAPTURED SHAPE MATTERS. AGENTS.md section 11 records four multi-hour
 * bugs that all passed a green suite, every one of them because the tests used
 * invented fixtures. The three real quirks below are all things an invented
 * fixture gets wrong:
 *
 *   1. `artist` and `album` arrive as { mbid, '#text' } - NOT { name }. The
 *      name lives under a hash-prefixed key, which is XML-ish residue from the
 *      original API. A fixture written as { name } would pass tests that the
 *      real payload fails.
 *   2. `date.uts` is a STRING, not a number. Every count in this API is a
 *      string; the instinct to Number() it is usually right and occasionally
 *      masks a real null.
 *   3. The SMALLEST image in the `image` array is Last.fm's placeholder, hash
 *      2a96cbd8b46e442fc41c2b86b821562f. Confirmed in the captured payload.
 *      AGENTS.md section 3.2 exists because artwork silently becomes that grey
 *      box when the wrong size is picked, so the ordering is load-bearing.
 */

const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

/** Trimmed from a real `user.getrecenttracks` response. */
const capturedTrack = (over: Record<string, unknown> = {}) => ({
  name: 'Fine Without You',
  artist: { mbid: '477b8c0c-c5fc-4ad2-b5b2-191f0bf2a9df', '#text': 'Armin van Buuren' },
  album: { mbid: '', '#text': 'Dream Dance Vol.48' },
  url: 'https://www.last.fm/music/Armin+van+Buuren/_/Fine+Without+You',
  mbid: 'c1945b02-f276-44f9-88e5-20a585ed5778',
  streamable: 0,
  date: { uts: '1287702031', '#text': '21 Oct 2010, 23:00' },
  image: [
    { size: 'small', '#text': `https://lastfm-img.freetls.fastly.net/i/u/34s/${PLACEHOLDER}.png` },
    { size: 'medium', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/64s/real-medium.png' },
    { size: 'large', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/174s/real-large.png' },
    { size: 'extralarge', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/300x300/real-xl.png' },
  ],
  ...over,
});

const envelope = (tracks: unknown, attr: Record<string, unknown> = {}) => ({
  recenttracks: {
    '@attr': { user: 'DreadRock', totalPages: '3787', page: '1', total: '11361', perPage: '3', ...attr },
    track: tracks,
  },
});

const makeRepo = (impl: (method: string, params: Record<string, string>) => unknown) => {
  const api = {
    call: vi.fn(async (method: string, params: Record<string, string> = {}) => impl(method, params)),
    callSigned: vi.fn(async (method: string, params: Record<string, string> = {}) => impl(method, params)),
  };
  return { repo: new LastFmRepository(api as never), api };
};

describe('LastFmRepository.getUserRecentTracks', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('converts a captured payload, reading the artist name from #text', async () => {
    const { repo } = makeRepo(() => envelope([capturedTrack()]));

    const [track] = await repo.getUserRecentTracks('DreadRock', 10, 1);

    expect(track).toBeDefined();
    // `#text`, not `name`. This is the assertion that an invented fixture
    // would never produce, and the one that matters.
    expect(track!.artistName).toBe('Armin van Buuren');
    expect(track!.name).toBe('Fine Without You');
    expect(track!.albumName).toBe('Dream Dance Vol.48');
  });

  it('passes limit, page and user through to the API', async () => {
    const { repo, api } = makeRepo(() => envelope([]));

    await repo.getUserRecentTracks('DreadRock', 25, 3);

    expect(api.call).toHaveBeenCalledWith('user.getrecenttracks', {
      user: 'DreadRock', limit: '25', page: '3',
    });
  });

  it('omits `from` when no timestamp is given, rather than sending an empty one', async () => {
    // An empty `from=` makes Last.fm return the oldest page instead of the
    // newest, which silently breaks every delta sync.
    const { repo, api } = makeRepo(() => envelope([]));

    await repo.getUserRecentTracks('DreadRock', 10, 1);

    const params = (api.call as unknown as { mock: { calls: Record<string, string>[][] } }).mock.calls[0]?.[1];
    expect(params).not.toHaveProperty('from');
  });

  it('sends `from` when a cursor timestamp is supplied', async () => {
    const { repo, api } = makeRepo(() => envelope([]));

    await repo.getUserRecentTracks('DreadRock', 10, 1, 1287702031);

    const params = (api.call as unknown as { mock: { calls: Record<string, string>[][] } }).mock.calls[0]?.[1];
    expect(params).toHaveProperty('from', '1287702031');
  });

  it('routes through the signed call when a session key is present', async () => {
    // The session key unlocks private scrobbles; using the unsigned call would
    // quietly return a shorter history for a user who has scrobbles hidden.
    const { repo, api } = makeRepo(() => envelope([]));

    await repo.getUserRecentTracks('DreadRock', 10, 1, undefined, 'session-key-123');

    expect(api.callSigned).toHaveBeenCalled();
    expect(api.call).not.toHaveBeenCalled();
    const params = (api.callSigned as unknown as { mock: { calls: Record<string, string>[][] } }).mock.calls[0]?.[1];
    expect(params).toHaveProperty('sk', 'session-key-123');
  });

  it('returns an empty list when Last.fm sends a single track object, not an array', async () => {
    // A one-result page arrives as a bare object on some endpoints. The code
    // normalises with `Array.isArray(...) ? ... : []`, so this documents the
    // current behaviour: the track is DROPPED, not wrapped.
    // Pinned deliberately - if this ever matters, the fix is a wrap, and this
    // test is the thing that will point at it.
    const { repo } = makeRepo(() => envelope(capturedTrack()));

    await expect(repo.getUserRecentTracks('DreadRock', 10, 1)).resolves.toEqual([]);
  });

  it('returns an empty list for a user with no scrobbles at all', async () => {
    const { repo } = makeRepo(() => envelope([]));
    await expect(repo.getUserRecentTracks('nobody', 10, 1)).resolves.toEqual([]);
  });

  it('does not throw when the API rejects, returning an empty list instead', async () => {
    // A Last.fm outage must not take out a command. The warn-and-return is
    // load-bearing: the alternative propagates into the Discord interaction.
    const { repo } = makeRepo(() => { throw new Error('Last.fm is down'); });

    await expect(repo.getUserRecentTracks('DreadRock', 10, 1)).resolves.toEqual([]);
  });

  it('maps a captured now-playing entry, which carries an @attr the others do not', async () => {
    // A currently-playing scrobble has @attr.nowplaying and NO date. If the
    // converter assumed date.uts exists, this would be the case that breaks.
    //
    // The value is the STRING "true", per Last.fm's own docs: "Also includes
    // the currently playing track with the nowplaying=\"true\" attribute if the
    // user is currently listening." The first version of this test used "1",
    // which is the more intuitive guess and which the converter correctly does
    // NOT match - so the test failed and the fixture was wrong, not the code.
    // Worth recording: I could not catch a live now-playing entry across 15
    // users, so this assertion rests on the documentation rather than on a
    // captured payload, and it is labelled as such.
    const nowPlaying = capturedTrack({
      '@attr': { nowplaying: 'true' },
      date: undefined,
    });
    const { repo } = makeRepo(() => envelope([nowPlaying, capturedTrack()]));

    const tracks = await repo.getUserRecentTracks('DreadRock', 10, 1);

    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.nowPlaying).toBe(true);
    expect(tracks[1]?.nowPlaying).toBeFalsy();
  });

  it('does not treat the string "1" as now-playing', async () => {
    // Pinned so the intent is explicit rather than accidental: Last.fm sends
    // the string "true", and only that.
    const { repo } = makeRepo(() => envelope([capturedTrack({ '@attr': { nowplaying: '1' } })]));

    const [track] = await repo.getUserRecentTracks('DreadRock', 10, 1);
    expect(track?.nowPlaying).toBe(false);
  });
});

describe('LastFmRepository artwork selection', () => {
  it('picks the LARGEST real image, not merely "not the placeholder"', async () => {
    // The first version of this test only asserted `not.toContain(placeholder)`,
    // and four mutations survived it - because the placeholder is the SMALLEST
    // image, so "not the placeholder" passes even with the priority order
    // reversed. Asserting the size pins the order, which is the actual
    // invariant: AGENTS.md 3.2 exists because artwork silently degrades.
    const { repo } = makeRepo(() => envelope([capturedTrack()]));

    const [track] = await repo.getUserRecentTracks('DreadRock', 10, 1);

    expect(track?.imageUrl).toContain('300x300'); // extralarge
  });

  it('returns no image at all when every candidate is the placeholder', async () => {
    // A track with no real artwork. Returning the placeholder would post a grey
    // box for that scrobble, which is worse than no image - the artwork cascade
    // gets a chance to find something real instead.
    const allPlaceholder = capturedTrack({
      image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({
        size,
        '#text': `https://lastfm-img.freetls.fastly.net/i/u/300x300/${PLACEHOLDER}.png`,
      })),
    });
    const { repo } = makeRepo(() => envelope([allPlaceholder]));

    const [track] = await repo.getUserRecentTracks('DreadRock', 10, 1);

    expect(track?.imageUrl ?? '').not.toContain(PLACEHOLDER);
  });

  it('prefers a smaller REAL image over a larger placeholder', async () => {
    // The case where the size order and the placeholder filter disagree: the
    // big entry is the placeholder, so a naive "take extralarge" would take it.
    const mixed = capturedTrack({
      image: [
        { size: 'extralarge', '#text': `https://i/u/300x300/${PLACEHOLDER}.png` },
        { size: 'small', '#text': 'https://i/u/34s/real-small.png' },
      ],
    });
    const { repo } = makeRepo(() => envelope([mixed]));

    const [track] = await repo.getUserRecentTracks('DreadRock', 10, 1);

    expect(track?.imageUrl).toContain('real-small');
  });

  it('handles a track with no image array at all', async () => {
    const { repo } = makeRepo(() => envelope([capturedTrack({ image: undefined })]));

    const [track] = await repo.getUserRecentTracks('DreadRock', 10, 1);

    expect(track).toBeDefined();
    expect(track?.imageUrl).toBeUndefined();
  });
});
