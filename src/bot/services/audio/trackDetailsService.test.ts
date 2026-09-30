import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrackDetailsService } from './trackDetailsService';
import type { PreviewResolverService, ResolvedPreview } from './previewResolverService';
import type { EssentiaService } from './essentiaService';
import type { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

// Two module-level dependencies are mocked rather than injected: the resolver's
// constructor takes only three collaborators, and `getAudioSignalAndSr` /
// `setPreview` are module functions. Mocking them by module is the only way to
// reach the audio path without an ffmpeg download.
//
// `vi.hoisted` is load-bearing. `vi.mock` calls are hoisted to the top of the
// file, so a factory referencing a plain top-level `const` runs before that
// const is initialised and throws "Cannot access X before initialization" —
// which reads like a mocking problem and is actually an ordering one. `hoisted`
// moves the declaration into the same phase as the mock registration.
//
// The rest parameter is load-bearing too: a zero-arg `vi.fn` infers a `[]` call
// tuple, so `calls[0][1]` is a COMPILE error that `vitest run` never reports.
const { getAudioSignalAndSr, setPreview } = vi.hoisted(() => ({
  getAudioSignalAndSr: vi.fn(async (..._args: unknown[]) => ({
    signal: new Float32Array(44100),
    sampleRate: 44100,
  })),
  setPreview: vi.fn((..._args: unknown[]) => undefined),
}));

vi.mock('./audioSignalService', () => ({ getAudioSignalAndSr }));
vi.mock('./voiceMessageService', () => ({ setPreview }));

/**
 * FINDING (not fixed — test-only task): a Spotify SEARCH url is accepted as a
 * Spotify TRACK url.
 * `trackDetailsService.ts:69` guards on
 * `resolved.storeUrl?.includes('spotify.com')`, which a search page matches as
 * readily as a track page. `previewResolverService.ts:95` is the source of
 * such a URL: when the Spotify scraper returns no `spotifyUrl`, the resolver
 * substitutes `https://open.spotify.com/search/<artist> <track>`. So a
 * spotify-sourced row that fell back to the search link skips the
 * `getSpotifyTrackUrl` lookup on line 72 entirely and the card links the user to
 * a search results page. Tightening the guard to a `/track/` shape would fix it
 * and is a one-line change. The test named "a spotify-sourced row carrying a
 * spotify.com SEARCH url skips the lookup entirely" pins today's behaviour so
 * the change is a deliberate one.
 */

const resolved = (over: Partial<ResolvedPreview> = {}): ResolvedPreview => ({
  trackName: 'Creep',
  artistName: 'Radiohead',
  albumName: 'Pablo Honey',
  durationMs: 239_000,
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a',
  storeUrl: 'https://music.apple.com/us/album/creep/123',
  artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/abc600x600bb.jpg',
  source: 'apple',
  ...over,
});

const build = (over: {
  resolved?: ResolvedPreview | null;
  available?: boolean;
  feats?: { bpm: number; key: string } | null;
  spotifyUrl?: string | null;
} = {}) => {
  const resolve = vi.fn(async (..._args: unknown[]) => over.resolved ?? null);
  const isAvailable = vi.fn(() => over.available ?? true);
  const analyze = vi.fn((..._args: unknown[]) => over.feats === undefined ? { bpm: 123, key: 'A' } : over.feats);
  const getSpotifyTrackUrl = vi.fn(async (..._args: unknown[]) => over.spotifyUrl ?? null);
  const svc = new TrackDetailsService(
    { resolve } as unknown as PreviewResolverService,
    { isAvailable, analyze } as unknown as EssentiaService,
    { getSpotifyTrackUrl } as unknown as SpotifySearchApi,
  );
  return { svc, resolve, isAvailable, analyze, getSpotifyTrackUrl };
};

beforeEach(() => {
  vi.clearAllMocks();
  getAudioSignalAndSr.mockResolvedValue({ signal: new Float32Array(44100), sampleRate: 44100 });
});

describe('TrackDetailsService — the unresolved case', () => {
  it('an unresolved track is an empty card, not a throw', async () => {
    // The resolver returning null is the normal outcome for a track with no
    // preview anywhere. It must render as an absent card: every field empty and
    // `durationFormatted` already "0:00", so the caller never formats NaN.
    const { svc } = build({ resolved: null });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result).toEqual({
      trackName: 'Creep', artistName: 'Radiohead',
      durationMs: 0, durationFormatted: '0:00',
      bpm: null, key: null,
      previewUrl: null, storeUrl: null, artworkUrl: null, spotifyUrl: null,
      resolved: null,
    });
  });

  it('nothing downstream is called when the track does not resolve', async () => {
    const { svc, isAvailable, analyze, getSpotifyTrackUrl } = build({ resolved: null });

    await svc.getDetails('Radiohead', 'Creep', 'id-1');

    // No essentia probe, no Spotify lookup. A failed resolve must not turn
    // into an ffmpeg download or an API call for a track that does not exist.
    expect(isAvailable).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(getSpotifyTrackUrl).not.toHaveBeenCalled();
    expect(getAudioSignalAndSr).not.toHaveBeenCalled();
    expect(setPreview).not.toHaveBeenCalled();
  });
});

describe('TrackDetailsService — the resolved case', () => {
  it('the album hint is handed to the resolver untouched', async () => {
    const { svc, resolve } = build({ resolved: resolved() });

    await svc.getDetails('Radiohead', 'Creep', 'id-1', 'Pablo Honey');

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe('Radiohead');
    expect(resolve.mock.calls[0]?.[1]).toBe('Creep');
    expect(resolve.mock.calls[0]?.[2]).toBe('Pablo Honey');
  });

  it('duration is formatted as m:ss with the seconds padded', async () => {
    const { svc } = build({ resolved: resolved({ durationMs: 239_000 }) });

    // The bug this shape invites: 239 -> "3:239". The padStart is load-bearing
    // and a single-digit-seconds track is the only thing that catches it.
    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).durationFormatted).toBe('3:59');
  });

  it('a single-digit-seconds duration is zero-padded, not bare', async () => {
    const { svc } = build({ resolved: resolved({ durationMs: 65_000 }) });

    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).durationFormatted).toBe('1:05');
  });

  it('a missing duration maps to 0 and "0:00" rather than NaN', async () => {
    const { svc } = build({ resolved: resolved({ durationMs: undefined as unknown as number }) });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.durationMs).toBe(0);
    expect(result.durationFormatted).toBe('0:00');
  });

  it('a track over an hour formats its minutes, not a wrapped hour count', async () => {
    const { svc } = build({ resolved: resolved({ durationMs: 3_725_000 }) });

    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).durationFormatted).toBe('62:05');
  });

  it('the resolved row is passed through verbatim alongside the derived fields', async () => {
    const source = resolved();
    const { svc } = build({ resolved: source });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.resolved).toBe(source);
    expect(result.trackName).toBe('Creep');
    expect(result.artistName).toBe('Radiohead');
    expect(result.previewUrl).toBe(source.previewUrl);
    expect(result.storeUrl).toBe(source.storeUrl);
    expect(result.artworkUrl).toBe(source.artworkUrl);
  });

  it('the preview is registered under the track id so the voice message can find it', async () => {
    const { svc } = build({ resolved: resolved() });

    await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(setPreview).toHaveBeenCalledTimes(1);
    expect(setPreview.mock.calls[0]?.[0]).toBe('id-1');
    expect(setPreview.mock.calls[0]?.[1]).toBe('https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a');
  });

  it('a track with no uniqueId is not registered', async () => {
    const { svc } = build({ resolved: resolved() });

    await svc.getDetails('Radiohead', 'Creep', '');

    // Registering under "" would make every id-less lookup collide on the same
    // key, so a preview meant for one track could be served for another.
    expect(setPreview).not.toHaveBeenCalled();
  });
});

describe('TrackDetailsService — BPM and key', () => {
  it('a preview plus an available engine yields bpm and a formatted key', async () => {
    const { svc } = build({ resolved: resolved(), feats: { bpm: 123, key: 'Bb' } });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.bpm).toBe(123);
    // The sharps table exists because the card renders a single convention;
    // "Bb" and "A#" must not both reach the embed.
    expect(result.key).toBe('A#');
  });

  it('a key already in the target notation is passed through', async () => {
    const { svc } = build({ resolved: resolved(), feats: { bpm: 100, key: 'C' } });

    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).key).toBe('C');
  });

  it('an unknown key label is shown as-is rather than dropped', async () => {
    // The engine can return a spelling the table does not carry. Showing
    // "Amaj" is better than showing nothing at all.
    const { svc } = build({ resolved: resolved(), feats: { bpm: 100, key: 'Amaj' } });

    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).key).toBe('Amaj');
  });

  it('a "N/A" key is null, and the bpm alongside it is still kept', async () => {
    // Both are set from the same `feats` object, so a test that asserted only
    // on the key would pass even if the bpm were dropped alongside it.
    const { svc } = build({ resolved: resolved(), feats: { bpm: 128, key: 'N/A' } });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.key).toBeNull();
    expect(result.bpm).toBe(128);
  });

  it('the engine returning null leaves bpm and key null and does not throw', async () => {
    const { svc } = build({ resolved: resolved(), feats: null });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.bpm).toBeNull();
    expect(result.key).toBeNull();
    // The card still renders: the track is real and has a preview.
    expect(result.previewUrl).not.toBeNull();
  });

  it('an unavailable engine is not probed and downloads nothing', async () => {
    // `isAvailable()` gates the whole block. Calling it and then analysing
    // anyway would be a wasted ffmpeg download per track.
    const { svc, analyze } = build({ resolved: resolved(), available: false });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(analyze).not.toHaveBeenCalled();
    expect(getAudioSignalAndSr).not.toHaveBeenCalled();
    expect(result.bpm).toBeNull();
    expect(result.key).toBeNull();
  });

  it('a preview-less resolved track is not analysed at all', async () => {
    // The metadata resolved but there is no audio to decode. Downloading it
    // anyway would fail on a null URL.
    const { svc, isAvailable, analyze } = build({ resolved: resolved({ previewUrl: null }) });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(isAvailable).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(getAudioSignalAndSr).not.toHaveBeenCalled();
    expect(result.bpm).toBeNull();
  });

  it('the decoder is called with the track id and the resolved preview URL', async () => {
    const { svc } = build({ resolved: resolved() });

    await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(getAudioSignalAndSr).toHaveBeenCalledTimes(1);
    expect(getAudioSignalAndSr.mock.calls[0]?.[0]).toBe('id-1');
    expect(getAudioSignalAndSr.mock.calls[0]?.[1]).toBe('https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a');
  });

  it('the decoded signal AND its sample rate are both handed to the engine', async () => {
    // The sample rate is the second argument and the reason the BPM bug in
    // this subsystem existed: analysing a 48kHz signal as if it were 44.1kHz
    // returns a plausible wrong number rather than an obvious failure.
    getAudioSignalAndSr.mockResolvedValue({ signal: new Float32Array(44100), sampleRate: 48000 });
    const { svc, analyze } = build({ resolved: resolved() });

    await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]).toBeInstanceOf(Float32Array);
    expect(analyze.mock.calls[0]?.[1]).toBe(48000);
  });

  it('a decode failure degrades to no bpm, leaving the rest of the card intact', async () => {
    // A1: a lost capability is not a failed lookup. ffmpeg being unhappy must
    // cost the BPM, not the whole card.
    getAudioSignalAndSr.mockRejectedValue(new Error('ffmpeg exploded'));
    const { svc } = build({ resolved: resolved() });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.bpm).toBeNull();
    expect(result.key).toBeNull();
    expect(result.trackName).toBe('Creep');
    expect(result.previewUrl).not.toBeNull();
  });

  it('an engine that throws mid-analysis also degrades to no bpm', async () => {
    const { svc } = build({ resolved: resolved() });
    // Replace the double's return with a throw.
    const svcThrowing = new TrackDetailsService(
      { resolve: vi.fn(async (..._a: unknown[]) => resolved()) } as unknown as PreviewResolverService,
      {
        isAvailable: vi.fn(() => true),
        analyze: vi.fn((..._a: unknown[]) => { throw new Error('wasm trap'); }),
      } as unknown as EssentiaService,
      { getSpotifyTrackUrl: vi.fn(async (..._a: unknown[]) => null) } as unknown as SpotifySearchApi,
    );
    void svc;

    const result = await svcThrowing.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.bpm).toBeNull();
    expect(result.trackName).toBe('Creep');
  });
});

describe('TrackDetailsService — the Spotify link', () => {
  it('a spotify-sourced preview reuses its own store URL without a second lookup', async () => {
    const { svc, getSpotifyTrackUrl } = build({
      resolved: resolved({ source: 'spotify', storeUrl: 'https://open.spotify.com/track/abc' }),
      spotifyUrl: 'https://open.spotify.com/track/some-other-track',
    });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    // The resolved row already knows its Spotify id; asking again would let a
    // different track's URL replace the one that matches the preview.
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/abc');
    expect(getSpotifyTrackUrl).not.toHaveBeenCalled();
  });

  it('a non-spotify source is looked up by artist and title', async () => {
    const { svc, getSpotifyTrackUrl } = build({
      resolved: resolved({ source: 'apple' }),
      spotifyUrl: 'https://open.spotify.com/track/found',
    });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/found');
    expect(getSpotifyTrackUrl.mock.calls[0]?.[0]).toBe('Radiohead');
    expect(getSpotifyTrackUrl.mock.calls[0]?.[1]).toBe('Creep');
  });

  it('the lookup uses the RESOLVED names, not the ones that were asked for', async () => {
    // When the providers disagree on spelling, the resolved row is the better
    // search key — searching for the requested name finds a different track.
    const { svc, getSpotifyTrackUrl } = build({
      resolved: resolved({ source: 'apple', artistName: 'Radiohead', trackName: 'Creep (Remastered)' }),
      spotifyUrl: null,
    });

    await svc.getDetails('radhead', 'creep', 'id-1');

    expect(getSpotifyTrackUrl.mock.calls[0]?.[0]).toBe('Radiohead');
    expect(getSpotifyTrackUrl.mock.calls[0]?.[1]).toBe('Creep (Remastered)');
  });

  it('a failed Spotify lookup still falls back to a spotify.com store URL', async () => {
    // The last-resort line: the preview was already resolved from Spotify even
    // though the search API found nothing, so its link is still valid.
    const { svc } = build({
      resolved: resolved({ source: 'apple', storeUrl: 'https://open.spotify.com/track/from-store' }),
      spotifyUrl: null,
    });

    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).spotifyUrl).toBe('https://open.spotify.com/track/from-store');
  });

  it('a non-spotify store URL is not mistaken for a Spotify link', async () => {
    const { svc } = build({
      resolved: resolved({ source: 'apple', storeUrl: 'https://music.apple.com/us/album/creep/123' }),
      spotifyUrl: null,
    });

    // The guard is `.includes('spotify.com')`, so an Apple store page must not
    // be surfaced as a Spotify link on the card.
    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).spotifyUrl).toBeNull();
  });

  it('a spotify-sourced row carrying a spotify.com SEARCH url skips the lookup entirely', async () => {
    // Reported as a finding, not designed behaviour. The guard on line 69 is
    // `resolved.storeUrl?.includes('spotify.com')`, and a search URL contains
    // that substring, so a scraper that fell back to a search link is treated
    // as if it had a real track link: the `else if (this.spotifyApi)` lookup
    // below never runs, and the card is handed a search page where the user
    // expected a track. Pinned as CHARACTERISATION — if this is ever tightened
    // to a `/track/` shape, this test is the one that should fail loudly.
    const { svc, getSpotifyTrackUrl } = build({
      resolved: resolved({ source: 'spotify', storeUrl: 'https://open.spotify.com/search/Radiohead%20Creep' }),
      spotifyUrl: 'https://open.spotify.com/track/looked-up',
    });

    const result = await svc.getDetails('Radiohead', 'Creep', 'id-1');

    expect(getSpotifyTrackUrl).not.toHaveBeenCalled();
    expect(result.spotifyUrl).toBe('https://open.spotify.com/search/Radiohead%20Creep');
  });

  it('with no Spotify API injected the field is null, not a crash', async () => {
    // `spotifyApi` is the 3rd constructor parameter and is optional.
    const svc = new TrackDetailsService(
      { resolve: vi.fn(async (..._a: unknown[]) => resolved()) } as unknown as PreviewResolverService,
      { isAvailable: vi.fn(() => false), analyze: vi.fn() } as unknown as EssentiaService,
    );

    expect((await svc.getDetails('Radiohead', 'Creep', 'id-1')).spotifyUrl).toBeNull();
  });
});
