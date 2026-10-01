import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The preview hand-off store between a command that resolves a preview URL and
 * the button that later plays it.
 *
 * This Map used to be unbounded and never expired: every `/track` leaked an
 * entry for the process lifetime AND its Preview button stayed clickable
 * forever, so each press re-ran a download plus an ffmpeg transcode on demand
 * with no limit. The TTL + cap exist to close that. These tests pin the
 * eviction actually implemented, including three places where it is looser than
 * the comment claims (reported as findings, not asserted as correct).
 */

const TTL_MS = 30 * 60 * 1000;
const CAP = 500;

/**
 * Fresh module instance per test. `previewExpiry` is module-private and has no
 * exported reset, so a static import would carry one test's expired keys into
 * the next — and the sweep-on-write would then delete entries the current test
 * just seeded, silently. `vi.resetModules()` re-runs the module body, which
 * re-creates both Maps.
 */
const load = async (): Promise<typeof import('@bot/services/audio/voiceMessageService')> => {
  vi.resetModules();
  return import('@bot/services/audio/voiceMessageService');
};

type Store = Awaited<ReturnType<typeof load>>;

let mod: Store;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  mod = await load();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** Age the store past its TTL without going so far that other entries differ. */
const agePastTtl = (ms = TTL_MS + 1): void => {
  vi.advanceTimersByTime(ms);
};

describe('preview store — a live preview', () => {
  it('hands back exactly what was registered', () => {
    mod.setPreview('id-1', 'https://cdn.example/preview.m4a');
    expect(mod.getPreview('id-1')).toBe('https://cdn.example/preview.m4a');
  });

  it('an id that was never registered is undefined, not a stale hit', () => {
    // The distinction matters: undefined is what makes the caller say "this
    // preview has expired" instead of attempting a download against null.
    expect(mod.getPreview('never-registered')).toBeUndefined();
  });

  it('a re-register replaces the URL rather than appending a second entry', () => {
    mod.setPreview('id-1', 'https://cdn.example/first.m4a');
    mod.setPreview('id-1', 'https://cdn.example/second.m4a');
    expect(mod.getPreview('id-1')).toBe('https://cdn.example/second.m4a');
    expect(mod.previewMap.size).toBe(1);
  });

  it('a preview registered just before the TTL is still served', () => {
    mod.setPreview('id-1', 'https://cdn.example/p.m4a');
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(mod.getPreview('id-1')).toBe('https://cdn.example/p.m4a');
  });
});

describe('preview store — expiry', () => {
  it('an expired preview is refused rather than handed to a download', () => {
    mod.setPreview('id-1', 'https://cdn.example/p.m4a');
    agePastTtl();
    expect(mod.getPreview('id-1')).toBeUndefined();
  });

  it('reading an expired entry removes it, so the store shrinks on read', () => {
    mod.setPreview('id-1', 'https://cdn.example/p.m4a');
    agePastTtl();
    mod.getPreview('id-1');
    expect(mod.previewMap.has('id-1')).toBe(false);
    // Second read of the same id must not resurrect it.
    expect(mod.getPreview('id-1')).toBeUndefined();
  });

  it('expiry is per entry, not per store: a fresh entry survives an old one dying', () => {
    mod.setPreview('old', 'https://cdn.example/old.m4a');
    vi.advanceTimersByTime(TTL_MS - 1000);
    mod.setPreview('new', 'https://cdn.example/new.m4a');
    vi.advanceTimersByTime(2000);
    expect(mod.getPreview('old')).toBeUndefined();
    expect(mod.getPreview('new')).toBe('https://cdn.example/new.m4a');
  });

  it('re-registering an id restarts its TTL instead of inheriting the old deadline', () => {
    mod.setPreview('id-1', 'https://cdn.example/first.m4a');
    vi.advanceTimersByTime(TTL_MS - 1000);
    mod.setPreview('id-1', 'https://cdn.example/second.m4a');
    vi.advanceTimersByTime(2000);
    // Without the restart this would be undefined; the point of the test is
    // that the refresh counts as a NEW registration.
    expect(mod.getPreview('id-1')).toBe('https://cdn.example/second.m4a');
  });

  /**
   * FINDING (pinned as current behaviour, not asserted to be correct).
   *
   * `previewMap` is exported and mutable, and `setPreview` is not the only way
   * in. A row written straight onto the map carries no expiry record, so
   * `getPreview` skips the TTL branch entirely (`expiresAt === undefined`) and
   * serves it FOREVER — the exact unbounded-growth / permanently-clickable
   * button this store was added to prevent, reachable by any caller holding
   * the export. Worth an accessor that always writes both maps.
   */
  it('a row written straight onto the exported map has no TTL and never expires', () => {
    mod.previewMap.set('sneaky', 'https://cdn.example/sneaky.m4a');
    vi.advanceTimersByTime(TTL_MS * 10);
    expect(mod.getPreview('sneaky')).toBe('https://cdn.example/sneaky.m4a');
  });
});

describe('preview store — the hard cap', () => {
  it('stays bounded under sustained registration', () => {
    for (let i = 0; i < CAP + 200; i++) mod.setPreview(`bulk-${i}`, `https://cdn.example/${i}.m4a`);
    // Bounded, which is the load-bearing claim. See the off-by-one test below
    // for the exact number.
    expect(mod.previewMap.size).toBeLessThanOrEqual(CAP + 1);
  });

  it('the newest entries are the ones that survive', () => {
    for (let i = 0; i < CAP + 50; i++) mod.setPreview(`bulk-${i}`, `https://cdn.example/${i}.m4a`);
    expect(mod.getPreview(`bulk-${CAP + 49}`)).toBe(`https://cdn.example/${CAP + 49}.m4a`);
    // The very first registrations are what the cap drops.
    expect(mod.getPreview('bulk-0')).toBeUndefined();
  });

  /**
   * FINDING (pinned as current behaviour, not asserted to be correct).
   *
   * `evictExpiredPreviews` runs BEFORE the insert, and its `while` only trims
   * down to the cap — it can never trim the entry about to be added. So the
   * steady-state size is `PREVIEW_MAX_ENTRIES + 1`, i.e. 501, not the 500 the
   * constant and its comment describe. One entry over a "hard cap" is not worth
   * an incident, but the comment claims a bound the number does not keep, so a
   * future reader sizing memory against it is off by one entry per map. Running
   * the eviction AFTER `set` (or comparing `>=`) fixes it.
   */
  it('settles at cap+1 entries, because eviction runs before the insert', () => {
    for (let i = 0; i < 1000; i++) mod.setPreview(`bulk-${i}`, `https://cdn.example/${i}.m4a`);
    expect(mod.previewMap.size).toBe(CAP + 1);
  });

  /**
   * FINDING (pinned as current behaviour, not asserted to be correct).
   *
   * The cap evicts by Map INSERTION order, and `Map.set` on an existing key
   * does not move it to the end. So re-registering a long-lived preview (the
   * exact "user pressed Preview again" case) refreshes its TTL but leaves it
   * sitting at the head of the eviction order — it can be dropped the moment
   * the cap is hit while a much newer entry survives. Evicting by `expiresAt`
   * (oldest deadline first) would match the stated intent.
   */
  it('a refreshed entry keeps its original eviction position', () => {
    mod.setPreview('pinned', 'https://cdn.example/first.m4a');
    // Fill the store so the cap is reached, then push two more past it.
    for (let i = 0; i < CAP - 1; i++) mod.setPreview(`filler-${i}`, `https://cdn.example/f${i}.m4a`);
    expect(mod.previewMap.size).toBe(CAP);
    mod.setPreview('overflow-1', 'https://cdn.example/o1.m4a');
    mod.setPreview('overflow-2', 'https://cdn.example/o2.m4a');
    // `pinned` is the first insertion in the map and therefore the first thing
    // the cap drops, even though it is the oldest key in the map and a
    // refresh cannot save it.
    expect(mod.getPreview('pinned')).toBeUndefined();
    expect(mod.getPreview('overflow-2')).toBe('https://cdn.example/o2.m4a');
  });
});

describe('preview store — register evicts what has already died', () => {
  it('an expired entry is dropped from the map when a NEW preview is registered', () => {
    mod.setPreview('stale', 'https://cdn.example/stale.m4a');
    agePastTtl();
    mod.setPreview('fresh', 'https://cdn.example/fresh.m4a');
    // Without the sweep-on-write the stale entry would sit here forever,
    // because nothing ever reads it again.
    expect(mod.previewMap.has('stale')).toBe(false);
    expect(mod.getPreview('fresh')).toBe('https://cdn.example/fresh.m4a');
  });

  it('a store of only-expired entries is emptied by one write', () => {
    for (let i = 0; i < 20; i++) mod.setPreview(`old-${i}`, `https://cdn.example/${i}.m4a`);
    agePastTtl();
    mod.setPreview('newcomer', 'https://cdn.example/new.m4a');
    expect(mod.previewMap.size).toBe(1);
    expect(mod.getPreview('newcomer')).toBe('https://cdn.example/new.m4a');
  });

  it('sweeping on write does not evict a still-live entry', () => {
    mod.setPreview('live', 'https://cdn.example/live.m4a');
    vi.advanceTimersByTime(TTL_MS - 1);
    mod.setPreview('newcomer', 'https://cdn.example/new.m4a');
    expect(mod.getPreview('live')).toBe('https://cdn.example/live.m4a');
  });
});
