/**
 * `TrackDetailsBuilders` — the `.trackdetails` card.
 *
 * This card is the repo's purest honesty test, because the three sentences it can
 * print are the three states of the same question and two of them are about what
 * the bot DOES NOT KNOW:
 *
 *   bpm + key known  -> "has 140.0 bpm, is in key G# and lasts 3:18"
 *   no bpm/key       -> "lasts 3:18 (No Spotify track metadata found)"
 *   no length either -> "is a track that we don't have any metadata for, sorry"
 *
 * The middle sentence is the branch that matters: a missing BPM must produce a
 * SENTENCE, never a bpm of 0. And the missing-metadata card must still carry a
 * disabled Preview button rather than a live button that cannot work.
 *
 * The card also writes the preview url into a module-level store that the
 * `track-preview:` button handler reads back under the FIRST colon-delimited
 * segment of the custom id, so the id the builder writes and the key the handler
 * reads must agree. That contract is asserted here rather than assumed — the
 * handler lives in `trackPreviewInteractions`, which is not imported here on
 * purpose (it drags in ffmpeg and the config graph), so the prefix is spelled
 * out and the test is the thing that keeps the two sides in step.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TrackDetailsBuilders } from '@bot/builders/trackDetailsBuilders';
import { getPreview } from '@bot/services/audio/voiceMessageService';
import type { ResponseModel } from '@bot/models/responseModel';
import type { TrackDetailsResult } from '@bot/services/audio/trackDetailsService';
import type { ResolvedPreview } from '@bot/services/audio/previewResolverService';

interface BuiltButton {
  custom_id?: string;
  label?: string;
  url?: string;
  disabled?: boolean;
}

/** `unknown` in, `BuiltButton` out: the builder hands back discord.js JSON. */
const toButton = (c: unknown): BuiltButton => c as BuiltButton;

const rowButtons = (response: ResponseModel): BuiltButton[] =>
  response
    .buildComponents()
    .flatMap(row => row.toJSON().components)
    .map(toButton);

const resolved = (source: 'spotify' | 'apple' | 'deezer'): ResolvedPreview =>
  ({ source }) as unknown as ResolvedPreview;

/** The preview store is module-level and persists for the file, so ids must differ. */
let idCounter = 0;
const uniqueId = () => {
  idCounter += 1;
  return `clip-${idCounter}`;
};

const details = (over: Partial<TrackDetailsResult> = {}): TrackDetailsResult => ({
  trackName: 'Karma Police',
  artistName: 'Radiohead',
  durationMs: 198_000,
  durationFormatted: '3:18',
  bpm: 140,
  key: 'G#',
  previewUrl: 'https://preview/clip.m4a',
  storeUrl: 'https://open.spotify.com/track/1',
  artworkUrl: 'https://img/cover.jpg',
  spotifyUrl: 'https://open.spotify.com/track/1',
  resolved: resolved('spotify'),
  ...over,
});

const card = (over: Partial<TrackDetailsResult> = {}, id = uniqueId()) =>
  TrackDetailsBuilders.buildTrackDetailsResponse(details(over), id);

/** Store-link buttons only, with every store field cleared unless a test sets it. */
const storeLabels = (over: Partial<TrackDetailsResult> = {}) =>
  card({ resolved: null, spotifyUrl: null, storeUrl: null, ...over })
    .buildComponents()
    .flatMap(row => row.toJSON().components)
    .map(toButton)
    .filter(b => b.url)
    .map(b => b.label);

describe('TrackDetailsBuilders.buildTrackDetailsResponse: which sentence', () => {
  it('prints the full measurement when a bpm, a key and a length are all real', () => {
    expect(card().content).toBe('**Karma Police** by **Radiohead** has `140.0` bpm, is in key `G#` and lasts `3:18`');
  });

  it('keeps one decimal on the bpm, because 140.0 and 140.4 are not the same claim', () => {
    expect(card({ bpm: 140.44 }).content).toContain('`140.4` bpm');
    expect(card({ bpm: 0.05 }).content).toContain('`0.1` bpm');
  });

  it('says which half it is missing when there is a length but no bpm or key', () => {
    const noBpm = card({ bpm: null });
    const noKey = card({ key: null });
    expect(noBpm.content).toBe('**Karma Police** by **Radiohead** lasts `3:18` (No Spotify track metadata found)');
    expect(noKey.content).toBe(noBpm.content);
  });

  it('does not print a bpm of 0 when the analysis found none', () => {
    // The trap. Both of these are "no analysis", and neither may be rendered as
    // a bpm the analysis never produced.
    expect(card({ bpm: 0, key: null, durationMs: 0 }).content).toContain("don't have any metadata for");
    expect(card({ bpm: null, key: null, durationMs: 0 }).content).toContain("don't have any metadata for");
  });

  it('says it has no metadata at all when there is no length either', () => {
    expect(card({ bpm: null, key: null, durationMs: 0 }).content).toBe(
      "**Karma Police** by **Radiohead** is a track that we don't have any metadata for, sorry <:Whiskeydogearnest:1097591075822129292>",
    );
  });

  it('prefers the metadata sentence over the missing-metadata one whenever a length exists', () => {
    expect(card({ bpm: null, key: null, durationMs: 1000, durationFormatted: '0:01' }).content).toContain(
      'lasts `0:01`',
    );
  });

  it('uses content rather than an embed, so the sentence reads without colour', () => {
    const response = card();
    expect(response.isComponentsV2).toBe(false);
    expect(response.hasEmbed()).toBe(false);
    expect(response.content).toBeDefined();
  });
});

describe('TrackDetailsBuilders.buildTrackDetailsResponse: the preview button', () => {
  it('is live only when there is a preview url to play', () => {
    const live = rowButtons(card({}))[0];
    const dead = rowButtons(card({ previewUrl: null, spotifyUrl: null, storeUrl: null, resolved: null }))[0];
    expect(live?.custom_id).toContain('track-preview:');
    expect(live?.disabled).toBe(false);
    expect(dead?.disabled).toBe(true);
  });

  it('keeps the disabled preview button on the card rather than dropping it', () => {
    // A missing button reads as "there is no preview feature"; a disabled one
    // reads as "there is nothing to play here".
    const response = card({ previewUrl: null, spotifyUrl: null, storeUrl: null, resolved: null });
    expect(response.buildComponents()[0]?.toJSON().components).toHaveLength(1);
  });

  it('stores the preview url under the key the button handler will look it up with', () => {
    // The handler reads `customId.slice('track-preview:'.length).split(':')[0]`,
    // so the builder's trailing colon and the store key must agree or every
    // press answers "Preview expired".
    const id = uniqueId();
    const button = rowButtons(TrackDetailsBuilders.buildTrackDetailsResponse(details(), id))[0];
    const pressedId = (button?.custom_id ?? '').slice('track-preview:'.length).split(':')[0];
    expect(pressedId).toBe(id);
    expect(getPreview(pressedId ?? '')).toBe('https://preview/clip.m4a');
  });

  it('stores nothing when there was no preview url', () => {
    const id = uniqueId();
    TrackDetailsBuilders.buildTrackDetailsResponse(details({ previewUrl: null }), id);
    expect(getPreview(id)).toBeUndefined();
  });
});

describe('TrackDetailsBuilders.buildTrackDetailsResponse: which store the button points at', () => {
  it('labels a Spotify-resolved track as Spotify', () => {
    expect(storeLabels({ resolved: resolved('spotify'), spotifyUrl: 'https://open.spotify.com/track/1' })).toEqual([
      'Open on Spotify',
    ]);
  });

  it('labels a Deezer-resolved track as Deezer, not as Spotify', () => {
    expect(storeLabels({ resolved: resolved('deezer'), storeUrl: 'https://deezer.com/track/1' })).toEqual([
      'Open on Deezer',
    ]);
  });

  it('recognises Deezer by its url when the resolver did not say', () => {
    expect(storeLabels({ storeUrl: 'https://deezer.com/track/1' })).toEqual(['Open on Deezer']);
  });

  it('prefers a scraper spotify url over a store url the resolver returned', () => {
    const response = card({
      resolved: resolved('deezer'),
      spotifyUrl: 'https://open.spotify.com/track/9',
      storeUrl: 'https://deezer.com/track/9',
    });
    const link = rowButtons(response).find(b => b.url);
    expect(link?.label).toBe('Open on Spotify');
    expect(link?.url).toBe('https://open.spotify.com/track/9');
  });

  it('recognises Apple by its url when the resolver did not say', () => {
    expect(storeLabels({ storeUrl: 'https://music.apple.com/us/album/1' })).toEqual(['Open on Apple Music']);
    expect(storeLabels({ storeUrl: 'https://itunes.apple.com/track/1' })).toEqual(['Open on Apple Music']);
  });

  it('recognises Apple by its source when the url is from somewhere else entirely', () => {
    expect(storeLabels({ resolved: resolved('apple'), storeUrl: 'https://example.com/x' })).toEqual([
      'Open on Apple Music',
    ]);
  });

  it('adds no store button at all when there is no store url', () => {
    expect(storeLabels()).toEqual([]);
  });

  /**
   * Spotify, Deezer and Apple are the three stores the resolver knows about, and
   * all three are matched above. A url that falls through to the last branch is a
   * store we cannot name, so it gets no button: it used to be labelled "Open on
   * Spotify" with the Spotify emoji whatever the url actually was, which sends
   * the user to a control that misnames its own destination.
   */
  it('adds no store button for a url it cannot attribute to a store', () => {
    expect(storeLabels({ storeUrl: 'https://example.com/track/1' })).toEqual([]);
    expect(storeLabels({ storeUrl: 'https://bandcamp.com/track/1' })).toEqual([]);
  });

  it('keeps the Preview button, so the card still offers the one thing it knows', () => {
    const labels = card({ resolved: null, spotifyUrl: null, storeUrl: 'https://example.com/track/1' })
      .buildComponents()
      .flatMap(row => row.toJSON().components)
      .map(toButton)
      .filter(b => b.url);
    expect(labels).toEqual([]);
    expect(rowButtons(card({ resolved: null, spotifyUrl: null, storeUrl: 'https://example.com/track/1' }))[0]?.custom_id)
      .toContain('track-preview:');
  });
});

describe('TrackDetailsBuilders.buildNoMetadataResponse', () => {
  it('says the same thing as the built-in missing-metadata branch, with no buttons at all', () => {
    const response = TrackDetailsBuilders.buildNoMetadataResponse('Radiohead', 'Karma Police');
    expect(response.content).toBe(
      "**Karma Police** by **Radiohead** is a track that we don't have any metadata for, sorry <:Whiskeydogearnest:1097591075822129292>",
    );
    expect(response.buildComponents()).toEqual([]);
    expect(response.isComponentsV2).toBe(false);
  });
});
