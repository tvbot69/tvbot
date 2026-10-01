import { describe, expect, it } from 'vitest';
import {
  artTimingNumber,
  artTimingOutcome,
  moonlinkArtTiming,
  moonlinkClock,
  moonlinkNodeMap,
  moonlinkNodePool,
  moonlinkSourceName,
  moonlinkTrackKey,
} from '../moonlinkTypes';

/**
 * The adapter every Moonlink cast was moved into.
 *
 * Two properties matter more than the shapes:
 *  1. `moonlinkClock` returns the LIVE record. onPlayerSeek writes position and
 *     time back onto it and Moonlink reads them, so a copy would make every
 *     seek silently not take effect - with a green suite.
 *  2. Nothing throws on a partial payload. Moonlink emits during startup and
 *     teardown with half-built objects, and a throw here would break playback.
 */

describe('moonlinkClock', () => {
  it('returns the SAME object, so a write-back reaches Moonlink', () => {
    const live = { position: 1, time: 2 };
    const result = moonlinkClock(live);
    result!.position = 999;
    expect(live.position).toBe(999);
  });

  it.each([[null], [undefined], ['a string'], [42]])('returns null for %p', (input) => {
    expect(moonlinkClock(input)).toBeNull();
  });
});

describe('moonlinkTrackKey', () => {
  it('prefers encoded over uri and identifier', () => {
    expect(moonlinkTrackKey({ encoded: 'E', uri: 'U', identifier: 'I' })).toBe('E');
  });

  it('falls back to uri, then identifier', () => {
    expect(moonlinkTrackKey({ uri: 'U', identifier: 'I' })).toBe('U');
    expect(moonlinkTrackKey({ identifier: 'I' })).toBe('I');
  });

  // The chain FALLS THROUGH an unusable field rather than giving up, so these
  // resolve to 'U' - the stuck-track guard depends on it, since a track can
  // arrive with encoded:'' and a perfectly good uri.
  it.each([
    ['an empty encoded field', { encoded: '', uri: 'U' }],
    ['a non-string field', { encoded: 7, uri: 'U' }],
  ])('falls through %s to the next field', (_label, input) => {
    expect(moonlinkTrackKey(input)).toBe('U');
  });

  it('returns undefined when no identity field is usable', () => {
    expect(moonlinkTrackKey({ title: 'x' })).toBeUndefined();
  });

  it('returns undefined for a null track', () => {
    expect(moonlinkTrackKey(null)).toBeUndefined();
  });
});

describe('moonlinkSourceName', () => {
  it('returns the source when present', () => {
    expect(moonlinkSourceName({ sourceName: 'spotify' })).toBe('spotify');
  });

  it.each([
    ['absent', {}],
    ['empty', { sourceName: '' }],
    ['not a string', { sourceName: 5 }],
  ])('falls back to "unknown" when %s', (_label, input) => {
    expect(moonlinkSourceName(input)).toBe('unknown');
  });
});

describe('art timing helpers', () => {
  it('reads a numeric stamp', () => {
    expect(artTimingNumber({ _artLookupStartedAt: 1234 }, '_artLookupStartedAt')).toBe(1234);
  });

  it.each([
    ['absent', {}],
    ['NaN', { _artLookupStartedAt: Number.NaN }],
    ['a string', { _artLookupStartedAt: '1234' }],
  ])('returns null for a stamp that is %s', (_label, input) => {
    expect(artTimingNumber(input, '_artLookupStartedAt')).toBeNull();
  });

  it('defaults a missing outcome to the label the log line reads', () => {
    expect(artTimingOutcome({})).toBe('no-lookup');
    expect(artTimingOutcome({ _artLookupOutcome: 'db-hit' })).toBe('db-hit');
  });

  it('never throws on a null track', () => {
    const timing = moonlinkArtTiming(null);
    expect(artTimingNumber(timing, '_artLookupStartedAt')).toBeNull();
    expect(artTimingOutcome(timing)).toBe('no-lookup');
  });
});

describe('moonlink node pool', () => {
  it('returns the pool when the manager exposes one', () => {
    const add = (): void => undefined;
    expect(moonlinkNodePool({ nodes: { add } })?.add).toBe(add);
  });

  it.each([
    ['a manager with no nodes', {}],
    ['a null manager', null],
  ])('returns undefined for %s', (_label, input) => {
    expect(moonlinkNodePool(input)).toBeUndefined();
  });

  it('returns the node map only when it really is a Map', () => {
    const map = new Map<string, unknown>([['main', {}]]);
    expect(moonlinkNodeMap({ nodes: { nodes: map } })).toBe(map);
  });

  it('returns undefined when nodes is an object pretending to be a Map', () => {
    // The real guard: resurrectionNodes does `instanceof Map` before trusting
    // it, and a plain object here would throw on .get()/.set().
    expect(moonlinkNodeMap({ nodes: { nodes: { get: 1 } } })).toBeUndefined();
  });
});
