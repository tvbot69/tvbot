import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { adoptMirrorTrack } from '@bot/services/music/musicTrackAdoption';
import type { Track } from 'moonlink.js';
import type { MirrorTrack, MusicTrackRequester } from '@domain/models/music/musicTrack';

/**
 * `adoptMirrorTrack` — the stamp that turns a Lavalink hit into "the provider
 * track we asked for". Pure mutation, so everything is asserted on the object
 * it was handed.
 *
 * Two things it must get right, both of which have been live bugs:
 *
 *  1. The card must never show a video frame. A YouTube thumbnail already on
 *     the hit is not "art" — it looks like art to every downstream check, so
 *     adoption and backfill both skip it and the card holds a frame forever.
 *     Only a TRUSTED (non-thumbnail) override may replace the provider cover.
 *  2. Chapter context is stashed BEFORE the title is overwritten. Chapters are
 *     extracted from the raw upload title ("Artist - Song (Official Video)")
 *     and looked up by video id; once the provider name replaces it, both
 *     inputs are gone. The stashes must also survive an already-populated
 *     track (the resolver rung pre-fills them), and must not be overwritten
 *     with a worse value.
 */

const YT_THUMB = 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg';
const COVER = 'https://is1-ssl.mzstatic.com/image/thumb/cover600x600bb.jpg';

const REQUESTER: MusicTrackRequester = { id: 'u1' };

/** A Lavalink hit as moonlink hands one over. */
const hit = (over: Record<string, unknown> = {}): Track =>
  ({
    identifier: 'abc123def45',
    title: 'Zaid Khaled - Lame (Official Music Video)',
    author: 'Zaid Khaled VEVO',
    uri: 'https://www.youtube.com/watch?v=abc123def45',
    duration: 213_000,
    artworkUrl: YT_THUMB,
    requester: { id: 'someone-else' },
    ...over,
  }) as unknown as Track;

const rec = (t: Track): Record<string, unknown> => t as unknown as Record<string, unknown>;

const mirror = (over: Partial<MirrorTrack> = {}): MirrorTrack => ({
  name: 'Lame',
  artist: 'Zaid Khaled',
  durationMs: 213_000,
  searchQuery: 'Zaid Khaled - Lame',
  ...over,
});

describe('adoptMirrorTrack — the provider identity stamp', () => {
  it('replaces the raw upload title and channel author with the provider ones', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'https://open.spotify.com/track/abc');
    expect(t.title).toBe('Lame');
    expect(t.author).toBe('Zaid Khaled');
  });

  it('replaces the requester, so "who queued this" survives the adoption', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    expect(t.requester).toEqual(REQUESTER);
  });

  it('points the uri at the canonical Spotify page, converted from the spotify: URI', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ spotifyUri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' }), 'plugin', REQUESTER, 'src');
    expect(t.uri).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  });

  it('falls back to the provider page when there is no spotify URI', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ sourceUrl: 'https://www.deezer.com/track/1234' }), 'plugin', REQUESTER, 'src');
    expect(t.uri).toBe('https://www.deezer.com/track/1234');
  });

  it('falls back to the requested link when the provider row has no URL at all', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'https://open.spotify.com/track/only-here');
    expect(t.uri).toBe('https://open.spotify.com/track/only-here');
  });

  it('stamps the provider cover when the row has one', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ artworkUrl: COVER }), 'plugin', REQUESTER, 'src');
    expect(t.artworkUrl).toBe(COVER);
  });

  it('records the album only when the provider actually named one', () => {
    const withAlbum = hit();
    adoptMirrorTrack(withAlbum, mirror({ album: '  Lame (Single)  ' }), 'plugin', REQUESTER, 'src');
    expect(rec(withAlbum)._album).toBe('Lame (Single)');

    const without = hit();
    adoptMirrorTrack(without, mirror(), 'plugin', REQUESTER, 'src');
    expect(rec(without)._album).toBeUndefined();
  });

  it('treats a blank album as absent rather than stamping an empty header', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ album: '   ' }), 'plugin', REQUESTER, 'src');
    expect(rec(t)._album).toBeUndefined();
  });
});

describe('adoptMirrorTrack — the source badge', () => {
  it('labels the resolver rung LOCAL, so failure handling never mistakes it for plugin output', () => {
    // The moonlink track keeps the true backend label while the display model
    // gets the familiar badge; collapsing the two makes resolver output look
    // like a YouTube plugin hit, which is the wrong breaker.
    const t = hit();
    adoptMirrorTrack(t, mirror({ provider: 'spotify' }), 'resolver', REQUESTER, 'src');
    expect(rec(t).sourceName).toBe('local');
    expect(rec(t).source).toBe('local');
  });

  it('uses the provider for every other rung', () => {
    for (const rung of ['plugin', 'soundcloud'] as const) {
      const t = hit();
      adoptMirrorTrack(t, mirror({ provider: 'deezer' }), rung, REQUESTER, 'src');
      expect(rec(t).sourceName).toBe('deezer');
    }
  });

  it('a row with no provider defaults to spotify, so older callers keep the legacy badge', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    expect(rec(t).sourceName).toBe('spotify');
  });

  it('a trusted override source beats the rung, on both fields', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ provider: 'deezer' }), 'plugin', REQUESTER, 'src', { source: 'apple' });
    expect(rec(t).sourceName).toBe('apple');
    expect(rec(t).source).toBe('apple');
  });
});

describe('adoptMirrorTrack — artwork is never a video frame', () => {
  it('a trusted override cover WINS over the provider art', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ artworkUrl: COVER }), 'plugin', REQUESTER, 'src', {
      artworkUrl: 'https://i.scdn.co/image/overridden',
    });
    expect(t.artworkUrl).toBe('https://i.scdn.co/image/overridden');
  });

  it('a YouTube-thumbnail override is REFUSED, and the provider cover stands', () => {
    // Overrides are trusted downstream (they skip backfill AND Spotify
    // enrichment), so stamping a video frame here would paint the card with it
    // permanently. Refusing leaves a real cover, or a known-blank that
    // backfill can fill.
    const t = hit();
    adoptMirrorTrack(t, mirror({ artworkUrl: COVER }), 'plugin', REQUESTER, 'src', { artworkUrl: YT_THUMB });
    expect(t.artworkUrl).toBe(COVER);
  });

  it('a YouTube-thumbnail override with NO provider art leaves the frame in place', () => {
    // Characterisation of the boundary: the point of the stamp is "a trusted
    // non-thumbnail cover wins". Refusing a thumbnail is right; erasing the
    // existing image is `preCleanArtwork`'s job, and it runs BEFORE adoption.
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src', { artworkUrl: YT_THUMB });
    expect(t.artworkUrl).toBe(YT_THUMB);
  });

  it('a non-YouTube thumbnail override is accepted — only the YouTube family is excluded', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror({ artworkUrl: COVER }), 'plugin', REQUESTER, 'src', {
      artworkUrl: 'https://example.test/cover-from-picker.jpg',
    });
    expect(t.artworkUrl).toBe('https://example.test/cover-from-picker.jpg');
  });
});

describe('adoptMirrorTrack — chapter context is stashed, not lost', () => {
  it('captures the raw upload title BEFORE the provider name overwrites it', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    // Chapters are parsed out of this ("Artist - Title (Official Music Video)"),
    // and `extractArtistFromTitle` on the provider name finds no " - ".
    expect(rec(t)._rawVideoTitle).toBe('Zaid Khaled - Lame (Official Music Video)');
    expect(t.title).toBe('Lame');
  });

  it('captures the 11-char video id when the hit is a YouTube one', () => {
    const t = hit({ sourceName: 'youtube' });
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    expect(rec(t)._sourceVideoId).toBe('abc123def45');
  });

  it('captures the id when the hit carries no source at all', () => {
    const t = hit();
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    expect(rec(t)._sourceVideoId).toBe('abc123def45');
  });

  it('REFUSES a non-11-char identifier, which is not a YouTube id', () => {
    // The Data API would 404 on it, and a wrong id could resolve to a
    // different video's chapters.
    for (const bad of ['abcdefghijkl', 'abc123def4', 'not an id!!']) {
      const t = hit({ identifier: bad, sourceName: 'youtube' });
      adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
      expect(rec(t)._sourceVideoId).toBeUndefined();
    }
  });

  it('does not claim a video id for a hit that came from another source', () => {
    // A SoundCloud permalink that happens to be 11 characters is not a video.
    const t = hit({ identifier: 'abcdefghijk', sourceName: 'soundcloud' });
    adoptMirrorTrack(t, mirror(), 'soundcloud', REQUESTER, 'src');
    expect(rec(t)._sourceVideoId).toBeUndefined();
  });

  it('never overwrites context a previous rung already captured', () => {
    // The resolver rung stashes the SOURCE video's id onto the local file it
    // returns. Adoption runs on that local file, whose own identifier is a
    // filesystem path — and the guard is on presence, not on the value.
    const t = hit({
      identifier: 'C:\\yt-cache\\abc123def45.webm',
      _sourceVideoId: 'abc123def45',
      _rawVideoTitle: 'Zaid Khaled - Lame (Official Music Video)',
    });
    adoptMirrorTrack(t, mirror(), 'resolver', REQUESTER, 'src');
    expect(rec(t)._sourceVideoId).toBe('abc123def45');
    expect(rec(t)._rawVideoTitle).toBe('Zaid Khaled - Lame (Official Music Video)');
  });

  it('an EMPTY pre-adoption title stashes nothing, rather than stashing the empty string', () => {
    // The guard is `&& lavalinkTrack.title`, so a titleless hit ends up with
    // `_rawVideoTitle` absent — which every reader treats as "no context".
    // Pinned so the behaviour is a decision and not an accident.
    const t = hit({ title: '' });
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    expect(rec(t)._rawVideoTitle).toBeUndefined();
  });

  it('a hit with no title at all takes the provider name without a stash', () => {
    const t = hit({ title: undefined });
    adoptMirrorTrack(t, mirror(), 'plugin', REQUESTER, 'src');
    expect(t.title).toBe('Lame');
    expect(rec(t)._rawVideoTitle).toBeUndefined();
  });
});
