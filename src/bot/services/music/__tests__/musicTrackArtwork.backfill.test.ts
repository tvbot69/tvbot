import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MusicTrackArtwork,
  leadArtist,
  preCleanArtwork,
  sanitizeOverride,
  ARTWORK_TIMEOUT_MS,
  BACKGROUND_ARTWORK_TIMEOUT_MS,
} from '../musicTrackArtwork';
import type { PendingEntry, PendingQueueView } from '../musicTypes';
import type { SpotifyResolver } from '../spotifyResolver';
import type { ArtworkService } from '@bot/services/artworkService';
import type { MirrorTrack } from '@domain/models/music/musicTrack';
import type { Track } from 'moonlink.js';

/**
 * Artwork backfill — the module that decides whether the card shows a real
 * cover, a video frame, or nothing.
 *
 * Two invariants, and both have shipped a bug:
 *
 *  1. Art must NEVER gate audio. Every backfill is fire-and-forget behind a
 *     timeout, and every leg of the cascade is catch-all, because a cold
 *     provider cascade takes seconds and the listener should be hearing the
 *     track the whole time. A lookup that throws is a rung failing, not a
 *     reason to lose playback — nor a reason to paint something wrong.
 *  2. A "miss" must be OMITTED, never invented. The outcome is recorded
 *     (`_artLookupOutcome`) precisely so a later reader can tell a hit from a
 *     miss from "we never looked". A track the cascade genuinely could not
 *     find keeps its previous cover, and the card says nothing rather than
 *     showing the wrong image.
 */

const YT_THUMB = 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg';
const COVER = 'https://is1-ssl.mzstatic.com/image/thumb/cover600x600bb.jpg';

const track = (over: Record<string, unknown> = {}): Track =>
  ({
    identifier: 'abc123def45',
    title: 'Lame',
    author: 'Zaid Khaled',
    uri: 'https://www.youtube.com/watch?v=abc123def45',
    duration: 213_000,
    artworkUrl: null,
    ...over,
  }) as unknown as Track;

const rec = (t: Track): Record<string, unknown> => t as unknown as Record<string, unknown>;

type Artwork = {
  getTrackCoverBySpotifyId: ReturnType<typeof vi.fn>;
  getTrackCoverUrl: ReturnType<typeof vi.fn>;
  getArtistImageUrl: ReturnType<typeof vi.fn>;
};

const artwork = (over: Partial<Artwork> = {}): Artwork => ({
  getTrackCoverBySpotifyId: vi.fn(async (..._a: unknown[]) => null),
  getTrackCoverUrl: vi.fn(async (..._a: unknown[]) => null),
  getArtistImageUrl: vi.fn(async (..._a: unknown[]) => null),
  ...over,
});

const spotifyResolver = {
  parseSpotifyUrl: (uri: string) =>
    uri.startsWith('spotify:track:') || uri.includes('open.spotify.com/track/')
      ? { type: 'track', id: 'abc123' }
      : uri.startsWith('spotify:album:')
        ? { type: 'album', id: 'abc123' }
        : null,
};

const pendingView = (): PendingQueueView => {
  const store = new Map<string, PendingEntry[]>();
  return {
    get: (g) => store.get(g),
    set: (g, v) => void store.set(g, v),
    delete: (g) => void store.delete(g),
    has: (g) => store.has(g),
  };
};

const build = (svc?: Artwork, pending = pendingView()) => ({
  // The double stands in for the WHOLE ArtworkService and implements only the
  // three legs this module calls; nothing else on the service is reachable
  // from here, so the narrowing is at the seam and nowhere else.
  art: new MusicTrackArtwork(svc as unknown as ArtworkService, spotifyResolver as unknown as SpotifyResolver, pending),
  pending,
});

/** Run `run` under a fake clock, advance `ms`, then restore real time. */
const withClock = async <T>(run: () => Promise<T>, ms: number): Promise<T> => {
  vi.useFakeTimers();
  try {
    const pendingRun = run();
    await vi.advanceTimersByTimeAsync(ms);
    return await pendingRun;
  } finally {
    vi.useRealTimers();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the pure helpers', () => {
  it('leadArtist takes the first billed name and drops channel cruft', () => {
    expect(leadArtist('A, B & C feat. D')).toBe('A');
    expect(leadArtist('A / B / C')).toBe('A');
    expect(leadArtist('A & B')).toBe('A');
    expect(leadArtist('Radiohead - Topic')).toBe('Radiohead');
    expect(leadArtist('Zaid KhaledVEVO')).toBe('Zaid Khaled');
    expect(leadArtist('Artist feat. Other')).toBe('Artist');
    expect(leadArtist('Artist ft. Other')).toBe('Artist');
    expect(leadArtist('Artist with Other')).toBe('Artist');
    expect(leadArtist('Artist x Other')).toBe('Artist');
    expect(leadArtist('')).toBe('');
  });

  it('preCleanArtwork stamps a real cover and drops a raw YouTube frame', () => {
    const withFrame = { artworkUrl: YT_THUMB };
    preCleanArtwork(withFrame, COVER);
    expect(withFrame.artworkUrl).toBe(COVER);

    const frameOnly = { artworkUrl: YT_THUMB };
    preCleanArtwork(frameOnly, YT_THUMB);
    // A ytimg URL passed as TRUSTED art is treated as absent. Stamping it would
    // paint video frames on the card for the whole track.
    expect(frameOnly.artworkUrl).toBeNull();

    const nothing = { artworkUrl: null };
    preCleanArtwork(nothing, null);
    expect(nothing.artworkUrl).toBeNull();
  });

  it('sanitizeOverride drops a YouTube-thumbnail override and keeps everything else', () => {
    expect(sanitizeOverride({ title: 'T', artworkUrl: YT_THUMB })).toEqual({ title: 'T' });
    const good = { title: 'T', artworkUrl: COVER };
    expect(sanitizeOverride(good)).toBe(good);
    expect(sanitizeOverride(undefined)).toBeUndefined();
    expect(sanitizeOverride({})).toEqual({});
  });

  it('the two timeouts differ, and the background one is the longer', () => {
    // Background paths (JIT top-up, warmup) can wait out a slow cascade; the
    // foreground path cannot.
    expect(ARTWORK_TIMEOUT_MS).toBe(6000);
    expect(BACKGROUND_ARTWORK_TIMEOUT_MS).toBe(10000);
  });
});

describe('spotifyTrackId — the by-id leg', () => {
  it('reads a track id from a spotify: URI', () => {
    const { art } = build();
    expect(art.spotifyTrackId('spotify:track:abc123')).toBe('abc123');
  });

  it('refuses a non-track URI, so an album page is not searched as a track', () => {
    const { art } = build();
    expect(art.spotifyTrackId('spotify:album:abc123')).toBeUndefined();
    expect(art.spotifyTrackId('spotify:playlist:abc123')).toBeUndefined();
  });

  it('an absent or unparseable URI is undefined, never a throw', () => {
    const { art } = build();
    expect(art.spotifyTrackId(undefined)).toBeUndefined();
    expect(art.spotifyTrackId(null)).toBeUndefined();
    expect(art.spotifyTrackId('')).toBeUndefined();
    expect(art.spotifyTrackId('https://example.test/not-spotify')).toBeUndefined();
  });

  it('a resolver that throws yields no id, so the name cascade runs instead', () => {
    // Returning undefined never claims "this track has no cover".
    const art = new MusicTrackArtwork(
      undefined,
      {
        parseSpotifyUrl: () => {
          throw new Error('resolver exploded');
        },
      } as unknown as SpotifyResolver,
      pendingView(),
    );
    expect(art.spotifyTrackId('spotify:track:abc123')).toBeUndefined();
  });
});

describe('maybeBackfillArt — when it declines to look at all', () => {
  it('a track that already has art is left alone, with no provider call', async () => {
    const svc = artwork();
    const { art } = build(svc);
    const t = track({ artworkUrl: COVER });
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled');
    expect(t.artworkUrl).toBe(COVER);
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('a KNOWN cover short-circuits the lookup entirely', async () => {
    const svc = artwork();
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, COVER, 'Lame', 'Zaid Khaled');
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
    expect(rec(t)._artLookupOutcome).toBeUndefined();
  });

  it('no title and no artist means nothing to search for, so nothing is searched', async () => {
    const svc = artwork();
    const { art } = build(svc);
    const t = track({ title: '  ', author: '  ' });
    await art.maybeBackfillArt(t);
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
    expect(svc.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('with no artwork service wired the track is left bare and nothing throws', async () => {
    const { art } = build(undefined);
    const t = track();
    await expect(art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled')).resolves.toBeUndefined();
    expect(t.artworkUrl).toBeNull();
  });

  it('no track at all is a no-op, not a crash', async () => {
    const { art } = build(artwork());
    await expect(art.maybeBackfillArt(undefined as unknown as Track, undefined, 'Lame', 'Z')).resolves.toBeUndefined();
  });
});

describe('maybeBackfillArt — a hit', () => {
  it('stamps the cascade cover and records the outcome as a hit', async () => {
    const svc = artwork({ getTrackCoverUrl: vi.fn(async () => COVER) });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled');
    expect(t.artworkUrl).toBe(COVER);
    expect(rec(t)._artLookupOutcome).toBe('hit');
    expect(rec(t)._artLookupStartedAt).toBeGreaterThan(0);
    expect(rec(t)._artLookupResolvedAt).toBeGreaterThan(0);
  });

  it('a spotify: URI is tried by id FIRST, and a hit skips the name cascade', async () => {
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => COVER),
      getTrackCoverUrl: vi.fn(async () => 'https://img.example/other.jpg'),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, 'spotify:track:abc123');
    // The by-id leg carries no matching risk, so a hit there ends the cascade.
    expect(svc.getTrackCoverBySpotifyId).toHaveBeenCalledWith('abc123');
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
    expect(t.artworkUrl).toBe(COVER);
  });

  it('a by-id miss falls through to the name cascade', async () => {
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => null),
      getTrackCoverUrl: vi.fn(async () => COVER),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, 'spotify:track:abc123');
    expect(svc.getTrackCoverUrl).toHaveBeenCalledWith('Lame', 'Zaid Khaled');
    expect(t.artworkUrl).toBe(COVER);
  });

  /**
   * A by-id leg that THROWS is a RUNG failing, not the whole cascade failing.
   *
   * `maybeBackfillArt` used to wrap the whole lookup in one
   * `try { … } catch { return null }`, so an unguarded `getTrackCoverBySpotifyId`
   * aborted it: the name cascade and the artist rung were never asked, and a
   * track that Spotify→Deezer→Apple→Last.fm would have covered lost its art —
   * recorded as a clean `miss`, indistinguishable from "this song has no cover".
   * One 5xx cost a track its real cover. The by-id leg now carries its own
   * `.catch(() => null)`, so a throw is contained at the rung.
   */
  it('a by-id leg that THROWS still falls through to the name cascade', async () => {
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => {
        throw new Error('by-id 500');
      }),
      getTrackCoverUrl: vi.fn(async () => COVER),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, 'spotify:track:abc123');

    expect(svc.getTrackCoverBySpotifyId).toHaveBeenCalledWith('abc123');
    // The downstream rungs are asked, and the cover they find is taken.
    expect(svc.getTrackCoverUrl).toHaveBeenCalledWith('Lame', 'Zaid Khaled');
    expect(t.artworkUrl).toBe(COVER);
    expect(rec(t)._artLookupOutcome).toBe('hit');
  });

  it('a by-id leg that THROWS with nothing behind it is a miss, never a wrong image', async () => {
    // The opposite direction, and it must keep passing: containing a rung must
    // not turn a genuine clean sweep into a cover. Both remaining legs miss.
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => {
        throw new Error('by-id 500');
      }),
      getTrackCoverUrl: vi.fn(async () => null),
      getArtistImageUrl: vi.fn(async () => null),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, 'spotify:track:abc123');

    expect(svc.getTrackCoverUrl).toHaveBeenCalled();
    expect(svc.getArtistImageUrl).toHaveBeenCalled();
    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
  });

  /**
   * The name cascade was the rung left unguarded after the by-id leg was fixed —
   * the same bug, one rung later.
   *
   * It is the rung that throws most (Spotify → Deezer → Apple → Last.fm, four
   * provider calls in a row), and while it was unwrapped its throw skipped the
   * artist rung below and ended the lookup as a `miss`. A live set with no
   * catalogue cover has exactly one rung left after it, and that rung is the
   * artist's picture: losing it painted a blank card for a track the bot could
   * have covered, and the `miss` marker recorded it as "this song has no cover".
   */
  it('a name cascade that THROWS still reaches the artist rung, and takes what it found', async () => {
    const svc = artwork({
      getTrackCoverUrl: vi.fn(async () => {
        throw new Error('cascade 500');
      }),
      getArtistImageUrl: vi.fn(async () => 'https://img.example/artist.jpg'),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled');

    // The rung below the failure is still asked, and its answer is the answer.
    expect(svc.getArtistImageUrl).toHaveBeenCalledWith('Zaid Khaled', 'Lame');
    expect(t.artworkUrl).toBe('https://img.example/artist.jpg');
    expect(rec(t)._artLookupOutcome).toBe('hit');
  });

  it('a name cascade that THROWS does not skip the artist rung when the by-id rung ran first', async () => {
    // Both failure modes in one sweep: two contained rungs, and the third still
    // gets its turn. Containment is per rung, not "the first failure wins".
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => {
        throw new Error('by-id 500');
      }),
      getTrackCoverUrl: vi.fn(async () => {
        throw new Error('cascade 500');
      }),
      getArtistImageUrl: vi.fn(async () => 'https://img.example/artist.jpg'),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, 'spotify:track:abc123');

    expect(svc.getTrackCoverBySpotifyId).toHaveBeenCalledWith('abc123');
    expect(svc.getTrackCoverUrl).toHaveBeenCalledWith('Lame', 'Zaid Khaled');
    expect(svc.getArtistImageUrl).toHaveBeenCalledWith('Zaid Khaled', 'Lame');
    expect(t.artworkUrl).toBe('https://img.example/artist.jpg');
  });

  it('EVERY rung failing is a MISS, never a wrong image', async () => {
    // The direction that keeps the containment honest. With no wrapper `catch`
    // left in the lookup, "all three rungs threw" and "all three rungs found
    // nothing" have to produce the SAME honest result: a bare track, recorded
    // as a miss. A containment bug that turned an outage into a cover would show
    // up here as a non-null `artworkUrl`.
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => {
        throw new Error('by-id 500');
      }),
      getTrackCoverUrl: vi.fn(async () => {
        throw new Error('cascade 500');
      }),
      getArtistImageUrl: vi.fn(async () => {
        throw new Error('artist 500');
      }),
    });
    const { art } = build(svc);
    const t = track();
    await expect(art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, 'spotify:track:abc123'))
      .resolves.toBeUndefined();

    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
    // All three were actually asked — the miss is a real sweep, not a short
    // circuit that stopped at the first failure.
    expect(svc.getTrackCoverBySpotifyId).toHaveBeenCalledTimes(1);
    expect(svc.getTrackCoverUrl).toHaveBeenCalledTimes(1);
    expect(svc.getArtistImageUrl).toHaveBeenCalledTimes(1);
    // An outage is not a reason to repaint the card.
    expect(rec(t)._artLookupResolvedAt).toBeUndefined();
  });

  it('a name cascade that THROWS never reaches the card-refresh notifier', async () => {
    const notify = vi.fn();
    const svc = artwork({
      getTrackCoverUrl: vi.fn(async () => {
        throw new Error('cascade 500');
      }),
      getArtistImageUrl: vi.fn(async () => null),
    });
    const { art } = build(svc);
    art.setCardRefreshNotifier(notify);
    await art.maybeBackfillArt(track(), undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, null, 'g-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('the artist profile picture is the last rung, for a cover-less track', async () => {
    const svc = artwork({ getArtistImageUrl: vi.fn(async () => 'https://img.example/artist.jpg') });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled');
    expect(svc.getArtistImageUrl).toHaveBeenCalledWith('Zaid Khaled', 'Lame');
    expect(t.artworkUrl).toBe('https://img.example/artist.jpg');
  });

  it('when the TITLE names the performer, that name is the search target, not the uploader channel', async () => {
    // "EsDeeKid - Live at ..." — the title lead is the performer. The billed
    // author is often a channel called "gloss", which can strictly match a
    // same-named wrong artist.
    const svc = artwork({ getArtistImageUrl: vi.fn(async () => 'https://img.example/a.jpg') });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'EsDeeKid - Live at Fabric', 'gloss');
    expect(svc.getArtistImageUrl).toHaveBeenCalledWith('EsDeeKid', 'EsDeeKid - Live at Fabric');
    expect(svc.getArtistImageUrl).not.toHaveBeenCalledWith('gloss', expect.anything());
  });

  it('when the title lead IS the billed artist, the uploader is the target', async () => {
    const svc = artwork({ getArtistImageUrl: vi.fn(async () => 'https://img.example/a.jpg') });
    const { art } = build(svc);
    await art.maybeBackfillArt(track(), undefined, 'Radiohead - Creep Live', 'Radiohead');
    expect(svc.getArtistImageUrl).toHaveBeenCalledWith('Radiohead', 'Radiohead - Creep Live');
  });

  it('an artist leg that throws is a rung failing; the loop still ends in a MISS, not a wrong image', async () => {
    const svc = artwork({
      getArtistImageUrl: vi.fn(async () => {
        throw new Error('artist 500');
      }),
    });
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled');
    // Holds the previous cover rather than painting a wrong one.
    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
  });

  it('a billed author with no usable lead name is skipped rather than searched for with garbage', async () => {
    // `leadArtist` of a separator-only author is the empty string. Searching a
    // provider for "" returns some arbitrary image, which is exactly the wrong
    // picture painted on a card.
    const svc = artwork();
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', ' & ');
    expect(svc.getArtistImageUrl).not.toHaveBeenCalled();
    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
  });

  it('refreshes the card once art lands, through the wired notifier', async () => {
    const notify = vi.fn();
    const { art } = build(artwork({ getTrackCoverUrl: vi.fn(async () => COVER) }));
    art.setCardRefreshNotifier(notify);
    await art.maybeBackfillArt(track(), undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, null, 'g-1');
    expect(notify).toHaveBeenCalledWith('g-1');
  });

  it('does not notify without a guild id, rather than notifying nobody-with-undefined', async () => {
    const notify = vi.fn();
    const { art } = build(artwork({ getTrackCoverUrl: vi.fn(async () => COVER) }));
    art.setCardRefreshNotifier(notify);
    await art.maybeBackfillArt(track(), undefined, 'Lame', 'Zaid Khaled');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a notifier that throws does not turn a successful lookup into a failed one', async () => {
    const { art } = build(artwork({ getTrackCoverUrl: vi.fn(async () => COVER) }));
    art.setCardRefreshNotifier(() => {
      throw new Error('card publish blew up');
    });
    const t = track();
    await expect(art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, null, 'g-1'))
      .resolves.toBeUndefined();
    expect(t.artworkUrl).toBe(COVER);
  });
});

describe('maybeBackfillArt — a miss is OMITTED, never invented', () => {
  it('a cascade that finds nothing leaves the track bare and records the miss', async () => {
    const svc = artwork();
    const { art } = build(svc);
    const t = track();
    await art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled');
    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
    // The search STARTED and finished without a hit — that is a different fact
    // from "we never looked", and the marker is how a reader tells them apart.
    expect(rec(t)._artLookupStartedAt).toBeGreaterThan(0);
    expect(rec(t)._artLookupResolvedAt).toBeUndefined();
  });

  it('a cascade that throws is a MISS, not a wrong picture', async () => {
    const svc = artwork({
      getTrackCoverUrl: vi.fn(async () => {
        throw new Error('cascade exploded');
      }),
    });
    const { art } = build(svc);
    const t = track();
    await expect(art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled')).resolves.toBeUndefined();
    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
  });

  it('a miss does not refresh the card — there is nothing new to show', async () => {
    const notify = vi.fn();
    const { art } = build(artwork());
    art.setCardRefreshNotifier(notify);
    await art.maybeBackfillArt(track(), undefined, 'Lame', 'Zaid Khaled', ARTWORK_TIMEOUT_MS, null, 'g-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a lookup that outruns the budget is abandoned, and the track stays bare', async () => {
    // Art must never stall resolution: a cold cascade can take seconds and the
    // listener should already be hearing the track.
    const svc = artwork({ getTrackCoverUrl: vi.fn(() => new Promise(() => undefined)) });
    const { art } = build(svc);
    const t = track();
    await withClock(() => art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', 6_000), 6_000);
    expect(t.artworkUrl).toBeNull();
    expect(rec(t)._artLookupOutcome).toBe('miss');
  });

  it('a lookup that finishes INSIDE the budget never records a miss', async () => {
    const svc = artwork({ getTrackCoverUrl: vi.fn(async () => COVER) });
    const { art } = build(svc);
    const t = track();
    await withClock(() => art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', 6_000), 6_000);
    expect(t.artworkUrl).toBe(COVER);
    expect(rec(t)._artLookupOutcome).toBe('hit');
  });
});

describe('maybeBackfillArt — art that arrives after the race', () => {
  // The late-attach path is inherently a timer path, so this whole group runs
  // on a fake clock. The outer `afterEach` puts real time back.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('art arriving after the budget is LATE-ATTACHED rather than thrown away', async () => {
    let release!: (v: string) => void;
    const svc = artwork({ getTrackCoverUrl: vi.fn(() => new Promise<string>((r) => { release = r; })) });
    const { art } = build(svc);
    const t = track();
    const pending = art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', 6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    expect(t.artworkUrl).toBeNull();
    // The race abandons the lookup but does not cancel it; the cascade still
    // finishes and caches, and the track is still bare, so take it.
    release(COVER);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.artworkUrl).toBe(COVER);
    expect(rec(t)._artLookupOutcome).toBe('late-hit');
  });

  it('a late arrival on a track that already got art is discarded', async () => {
    let release!: (v: string) => void;
    const svc = artwork({ getTrackCoverUrl: vi.fn(() => new Promise<string>((r) => { release = r; })) });
    const { art } = build(svc);
    const t = track();
    const pending = art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', 6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    t.artworkUrl = 'https://img.example/won-a-race.jpg';
    release(COVER);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.artworkUrl).toBe('https://img.example/won-a-race.jpg');
  });

  it('a late arrival refreshes the card, so it is actually seen', async () => {
    const notify = vi.fn();
    let release!: (v: string) => void;
    const svc = artwork({ getTrackCoverUrl: vi.fn(() => new Promise<string>((r) => { release = r; })) });
    const { art } = build(svc);
    art.setCardRefreshNotifier(notify);
    const t = track();
    const pending = art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', 6_000, null, 'g-1');
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    expect(rec(t)._artLookupOutcome).toBe('miss');
    release(COVER);
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledWith('g-1');
  });

  it('a late rejection is swallowed rather than becoming an unhandled rejection', async () => {
    const svc = artwork({
      getTrackCoverUrl: vi.fn(() => Promise.reject(new Error('cascade exploded late'))),
    });
    const { art } = build(svc);
    const t = track();
    const pending = art.maybeBackfillArt(t, undefined, 'Lame', 'Zaid Khaled', 6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.artworkUrl).toBeNull();
  });
});

describe('warmUpcomingArt — cache prefill, never a dependency', () => {
  // Every warmup is fire-and-forget, so these run on a fake clock and only
  // assert on what the service STARTED doing. The outer `afterEach` puts real
  // time back.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** A full pending entry: `spTrack` is a real `MirrorTrack`, not a bag of fields. */
  const entry = (over: Partial<MirrorTrack> = {}): PendingEntry => ({
    spTrack: {
      name: 'Lame',
      artist: 'Zaid Khaled',
      searchQuery: 'Zaid Khaled Lame',
      durationMs: 213_000,
      ...over,
    },
    requester: { id: 'u1' },
    spotifyUrl: 'src',
  });

  it('does nothing with no artwork service wired', () => {
    const pending = pendingView();
    pending.set('g-1', [entry()]);
    const { art } = build(undefined, pending);
    expect(() => art.warmUpcomingArt('g-1')).not.toThrow();
  });

  it('does nothing for a guild with no pending entries', () => {
    const svc = artwork();
    const { art } = build(svc, pendingView());
    art.warmUpcomingArt('g-1');
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('warms at most the next couple of entries', async () => {
    const svc = artwork({ getTrackCoverUrl: vi.fn(async () => COVER) });
    const pending = pendingView();
    pending.set('g-1', [entry({ name: 'A' }), entry({ name: 'B' }), entry({ name: 'C' })]);
    const { art } = build(svc, pending);
    art.warmUpcomingArt('g-1');
    await vi.advanceTimersByTimeAsync(0);
    // Beyond two, the prefill is spending provider quota the resolve-time
    // backfill will need anyway.
    expect(svc.getTrackCoverUrl).toHaveBeenCalledTimes(2);
  });

  it('an entry that already carries art needs no lookup', async () => {
    const svc = artwork({ getTrackCoverUrl: vi.fn(async () => COVER) });
    const pending = pendingView();
    pending.set('g-1', [entry({ artworkUrl: COVER })]);
    const { art } = build(svc, pending);
    art.warmUpcomingArt('g-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('an entry whose OVERRIDE carries art needs no lookup either', async () => {
    const svc = artwork();
    const pending = pendingView();
    const e = entry();
    e.override = { artworkUrl: COVER };
    pending.set('g-1', [e]);
    const { art } = build(svc, pending);
    art.warmUpcomingArt('g-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('tries the by-id leg when the entry carries a spotify URI', async () => {
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => COVER),
      getTrackCoverUrl: vi.fn(async () => 'https://img.example/other.jpg'),
    });
    const pending = pendingView();
    pending.set('g-1', [entry({ spotifyUri: 'spotify:track:abc123' })]);
    const { art } = build(svc, pending);
    art.warmUpcomingArt('g-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.getTrackCoverBySpotifyId).toHaveBeenCalledWith('abc123');
    expect(svc.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('a by-id leg that THROWS during warmup still runs the name prefill', async () => {
    // The same containment hole as the resolve-time path, in the prefill: the
    // by-id 5xx used to abort the sweep, so the entry never got the cache
    // prefill that exists to make the REAL backfill hit cache instead of racing
    // four providers while the listener waits. Impact is bounded — the track is
    // still backfilled at play time — so a skipped prefill is a cold cache, not
    // a wrong cover, which is exactly why it survived the by-id fix in
    // `maybeBackfillArt` unfixed.
    const svc = artwork({
      getTrackCoverBySpotifyId: vi.fn(async () => {
        throw new Error('by-id 500');
      }),
      getTrackCoverUrl: vi.fn(async () => COVER),
    });
    const pending = pendingView();
    pending.set('g-1', [entry({ spotifyUri: 'spotify:track:abc123' })]);
    const { art } = build(svc, pending);
    expect(() => art.warmUpcomingArt('g-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(svc.getTrackCoverBySpotifyId).toHaveBeenCalledWith('abc123');
    expect(svc.getTrackCoverUrl).toHaveBeenCalledWith('Lame', 'Zaid Khaled');
  });

  it('a name prefill that THROWS is silent, and the warm ends without rejecting', async () => {
    // The last rung failing has no rung behind it, so its outcome is identical
    // whether it is caught at the rung or by the outer never-reject boundary —
    // but it must be a silent cold cache either way, never an unhandled
    // rejection in a fire-and-forget path.
    const svc = artwork({
      getTrackCoverUrl: vi.fn(() => Promise.reject(new Error('warmup 500'))),
    });
    const pending = pendingView();
    pending.set('g-1', [entry({ spotifyUri: 'spotify:track:abc123' })]);
    const { art } = build(svc, pending);
    expect(() => art.warmUpcomingArt('g-1')).not.toThrow();
    // A rejection escaping the fire-and-forget sweep is an unhandled rejection,
    // which vitest fails the run on — so reaching the next line at all is half
    // the assertion.
    await vi.advanceTimersByTimeAsync(0);
    // The dedupe key is released even when the sweep failed, or a failed warm
    // would block every later warmup of the same track.
    const keys = (art as unknown as { artWarmKeys: Set<string> }).artWarmKeys;
    expect(keys.size).toBe(0);
  });

  it('a warming leg that throws is silent — the track is still backfilled at play time', async () => {
    const svc = artwork({
      getTrackCoverUrl: vi.fn(async () => {
        throw new Error('warmup 500');
      }),
    });
    const pending = pendingView();
    pending.set('g-1', [entry()]);
    const { art } = build(svc, pending);
    expect(() => art.warmUpcomingArt('g-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    // A failed prefill cannot affect what the listener hears.
  });

  it('a slow warm is bounded by the background timeout, and the dedupe key is released', async () => {
    const svc = artwork({ getTrackCoverUrl: vi.fn(() => new Promise(() => undefined)) });
    const pending = pendingView();
    pending.set('g-1', [entry({ name: 'Slow' })]);
    const { art } = build(svc, pending);
    vi.useFakeTimers();
    try {
      art.warmUpcomingArt('g-1');
      await vi.advanceTimersByTimeAsync(BACKGROUND_ARTWORK_TIMEOUT_MS + 10);
      // The key is dropped in the `finally`, so a slow warm cannot permanently
      // block a later warmup of the same track.
      const keys = (art as unknown as { artWarmKeys: Set<string> }).artWarmKeys;
      expect(keys.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('concurrent warmups of the same track collapse into one lookup', async () => {
    const svc = artwork({ getTrackCoverUrl: vi.fn(() => new Promise(() => undefined)) });
    const pending = pendingView();
    pending.set('g-1', [entry({ name: 'Same' }), entry({ name: 'Same' })]);
    const { art } = build(svc, pending);
    vi.useFakeTimers();
    try {
      art.warmUpcomingArt('g-1');
      art.warmUpcomingArt('g-1');
      await vi.advanceTimersByTimeAsync(0);
      // The second entry is the same track, and one cascade is already in
      // flight; a second one is pure duplicate provider spend.
      expect(svc.getTrackCoverUrl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
