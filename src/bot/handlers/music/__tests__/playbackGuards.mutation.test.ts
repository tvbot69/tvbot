import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicHandler } from '@bot/handlers/music/musicHandler';
import { MusicEventListeners } from '@bot/handlers/music/musicEventListeners';
import {
  asDeletableChannel,
  asMessageChannel,
  asSendableChannel,
  isDeletableChannel,
  isMessageChannel,
  isSendableChannel,
  moonlinkChapterStash,
  moonlinkSourceLabels,
} from '@bot/services/music/moonlinkTypes';

/**
 * Guard tests for the two things this change introduced, and for the host
 * contract that replaced the `this as unknown as XHost` casts.
 *
 * These are written as MUTANT KILLERS, not coverage. A guard is only worth
 * having if a sloppy version of it fails here, so each block names the mutant
 * it kills. The shape is always the same pair:
 *
 *   - the REJECT direction, which kills every "just check the outer level" and
 *     every "truthiness is enough" mutant;
 *   - the ACCEPT direction through the real call site, which kills the
 *     over-strict mutant. That one matters more than it looks: a guard that
 *     rejects a genuine channel does not fail loudly, it silently stops
 *     publishing cards (root AGENTS.md §0A2).
 */

/* ------------------------------------------------------------------ *
 * asMessageChannel / isMessageChannel
 * ------------------------------------------------------------------ */

describe('isMessageChannel — the publisher channel guard', () => {
  const okMessages = () => ({ cache: { get: vi.fn() }, fetch: vi.fn() });

  it('accepts a channel whose message manager can read and fetch by id', () => {
    const channel = { isTextBased: () => true, messages: okMessages() };
    expect(isMessageChannel(channel)).toBe(true);
    expect(asMessageChannel(channel)).toBe(channel);
  });

  it('rejects a non-object channel', () => {
    // Kills a mutant that reaches into the argument before checking it.
    for (const input of [null, undefined, 'tc-1', 42, true, Symbol('x')]) {
      expect(isMessageChannel(input)).toBe(false);
      expect(asMessageChannel(input)).toBeNull();
    }
  });

  it('rejects a channel with no message manager at all', () => {
    // Kills `'messages' in channel` — a real channel type can be present with
    // the manager missing, and `in` says yes.
    expect(isMessageChannel({})).toBe(false);
    expect(isMessageChannel({ isTextBased: () => true })).toBe(false);
    expect(isMessageChannel({ messages: null })).toBe(false);
    expect(isMessageChannel({ messages: 'nope' })).toBe(false);
    expect(isMessageChannel({ messages: 7 })).toBe(false);
    expect(asMessageChannel({ messages: null })).toBeNull();
  });

  it('rejects a manager that exists but cannot read a message', () => {
    // Kills `!!asRecord(messages)` — the "presence is enough" mutant.
    expect(isMessageChannel({ messages: {} })).toBe(false);
    expect(isMessageChannel({ messages: { cache: {} } })).toBe(false);
    expect(isMessageChannel({ messages: { cache: null } })).toBe(false);
  });

  it('rejects a manager with no cache at all', () => {
    // Kills a mutant that checks `messages.fetch` and assumes a cache follows
    // it. `fetch` present is not enough — the publisher reads the cache first.
    expect(isMessageChannel({ messages: { fetch: vi.fn() } })).toBe(false);
  });

  it('rejects a manager with no fetch at all', () => {
    // Kills a mutant that checks the cache and assumes fetch follows it: the
    // cache-miss path is the one that would throw.
    expect(isMessageChannel({ messages: { cache: { get: vi.fn() } } })).toBe(false);
  });

  it('rejects a cache with no get', () => {
    // Kills a mutant that checks `messages` and `messages.fetch` only.
    expect(isMessageChannel({ messages: { cache: {}, fetch: vi.fn() } })).toBe(false);
    expect(isMessageChannel({ messages: { cache: null, fetch: vi.fn() } })).toBe(false);
  });

  it('rejects truthy-but-not-callable members', () => {
    // Kills the truthiness mutants: `'get' in cache`, `cache.get ?? noop`,
    // `typeof … === 'object'`. Each of these passes a guard written that way
    // and then throws at the call site, turning a recoverable "cannot edit the
    // card" into a thrown publish.
    expect(isMessageChannel({ messages: { cache: { get: 'get' }, fetch: vi.fn() } })).toBe(false);
    expect(isMessageChannel({ messages: { cache: { get: vi.fn() }, fetch: 1 } })).toBe(false);
    expect(isMessageChannel({ messages: { cache: { get: {} }, fetch: {} } })).toBe(false);
    expect(isMessageChannel({ messages: { cache: { get: vi.fn() }, fetch: { call: 1 } } })).toBe(false);
  });

  it('rejects a manager whose get returns a promise-like but non-object', () => {
    // The guard is about the SHAPE OF THE MANAGER, not its result: a manager
    // that satisfies the contract is accepted whatever get() hands back, and
    // the publisher's own null check owns that. Pinning it here keeps the two
    // decisions from being confused.
    const channel = { messages: { cache: { get: () => undefined }, fetch: vi.fn() } };
    expect(isMessageChannel(channel)).toBe(true);
  });

  it('hands back the LIVE channel, never a copy', () => {
    // Kills the "return a reconstructed shape" mutant. A copy would typecheck
    // and then quietly stop reflecting the real manager.
    const messages = okMessages();
    const channel = { messages };
    const narrowed = asMessageChannel(channel);
    expect(narrowed).not.toBeNull();
    expect(narrowed?.messages).toBe(messages);
  });
});

/* ------------------------------------------------------------------ *
 * asSendableChannel / asDeletableChannel
 * ------------------------------------------------------------------ */

describe('asSendableChannel — the trackStart post guard', () => {
  it('accepts a callable send and hands back the live channel', () => {
    const channel = { send: vi.fn() };
    expect(isSendableChannel(channel)).toBe(true);
    expect(asSendableChannel(channel)).toBe(channel);
  });

  it('rejects truthy-but-not-callable send', () => {
    // Kills `'send' in channel`, which the call site used to rely on and which
    // says yes for a partial mock carrying `send: undefined`.
    expect(isSendableChannel({})).toBe(false);
    expect(isSendableChannel({ send: undefined })).toBe(false);
    expect(isSendableChannel({ send: 'send' })).toBe(false);
    expect(asSendableChannel({ send: 'send' })).toBeNull();
  });

  it('is not satisfied by a deletable-only channel', () => {
    expect(isSendableChannel({ messages: { delete: vi.fn() } })).toBe(false);
  });
});

describe('asDeletableChannel — the card-teardown guard', () => {
  it('accepts a callable messages.delete and hands back the live channel', () => {
    const messages = { delete: vi.fn() };
    const channel = { messages };
    expect(isDeletableChannel(channel)).toBe(true);
    expect(asDeletableChannel(channel)).toBe(channel);
    expect(asDeletableChannel(channel)?.messages).toBe(messages);
  });

  it('rejects a partial or truthy-but-not-callable delete', () => {
    // Kills `'messages' in channel` AND the truthiness variant. The old
    // call sites had both: `messages` present was enough, and then
    // `messages.delete(...)` threw synchronously inside the teardown.
    for (const input of [
      null,
      undefined,
      'tc-1',
      {},
      { messages: null },
      { messages: {} },
      { messages: 'nope' },
      { messages: { delete: undefined } },
      { messages: { delete: 'delete' } },
      { messages: { delete: {} } },
    ]) {
      expect(isDeletableChannel(input)).toBe(false);
      expect(asDeletableChannel(input)).toBeNull();
    }
  });

  it('is not satisfied by a sendable-only channel', () => {
    expect(isDeletableChannel({ send: vi.fn() })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The track stashes
 * ------------------------------------------------------------------ */

describe('moonlinkChapterStash / moonlinkSourceLabels — live track records', () => {
  it('returns the LIVE record, so a write through it is readable afterwards', () => {
    // Kills the "narrow copy" mutant. The ladder WRITES the chapter context
    // here and `getVideoTitle`/`getSourceVideoId` read it back off the same
    // object; a copy would drop the stamp and the resolver local file would
    // lose its chapter title and video id.
    const track: Record<string, unknown> = { title: 'Esme' };
    const stash = moonlinkChapterStash(track);
    expect(stash).not.toBeNull();
    stash!._rawVideoTitle = 'Mond - Esme (Official Video)';
    stash!._sourceVideoId = 'abcdefghijk';
    expect(track._rawVideoTitle).toBe('Mond - Esme (Official Video)');
    expect(track._sourceVideoId).toBe('abcdefghijk');
  });

  it('returns the LIVE record for source labels', () => {
    const track: Record<string, unknown> = {};
    const labels = moonlinkSourceLabels(track);
    expect(labels).not.toBeNull();
    labels!.sourceName = 'youtube';
    labels!.source = 'youtube';
    expect(track.sourceName).toBe('youtube');
    expect(track.source).toBe('youtube');
  });

  it('returns null for anything that is not an object', () => {
    // Kills a mutant that hands back a fresh object instead of null, which
    // would let the ladder "stamp" a record nobody will ever read.
    for (const input of [null, undefined, 'track', 42, true, Symbol('x')]) {
      expect(moonlinkChapterStash(input)).toBeNull();
      expect(moonlinkSourceLabels(input)).toBeNull();
    }
  });

  it('reports the fields as unknown so a non-string falls through to the caller', () => {
    // A wrong-typed stamp must surface at the caller's `typeof` check, not be
    // laundered into a string here.
    const stash = moonlinkChapterStash({ _rawVideoTitle: 42, _sourceVideoId: {} });
    expect(typeof stash?._rawVideoTitle).toBe('number');
    expect(typeof stash?._sourceVideoId).toBe('object');
  });
});

/* ------------------------------------------------------------------ *
 * The guards at their real call sites
 * ------------------------------------------------------------------ */

const QUEUE = {
  guildId: 'g-guard-1',
  current: {
    identifier: 'yt-guard-001',
    title: 'Esme',
    author: 'Mond',
    uri: 'https://youtube.com/watch?v=ytguard001',
    duration: 200000,
    isSeekable: true,
    isStream: false,
    source: 'youtube',
    artworkUrl: 'https://img.test/esme.jpg',
  },
  tracks: [],
  totalTracks: 1,
  totalDuration: 200000,
  remainingDuration: 200000,
  loopMode: 'off',
  volume: 100,
  isPaused: false,
  isPlaying: true,
  is247: false,
  autoplay: false,
  activeFilters: [],
  position: 5000,
  ping: 0,
};

const buildPlayer = (store: Record<string, unknown> = { nowPlayingMessageId: 'msg-1' }) => ({
  guildId: 'g-guard-1',
  playing: true,
  paused: false,
  textChannelId: 'tc-1',
  voiceChannelId: 'vc-1',
  current: QUEUE.current,
  get: (k: string) => store[k],
  set: (k: string, v: unknown) => {
    store[k] = v;
  },
});

type HandlerView = {
  publishProgress: (player: unknown) => Promise<void>;
  progressFingerprintsView: Map<string, string>;
  clearCardTimers: (guildId: string) => void;
};

const buildHandler = (client: unknown): HandlerView =>
  new MusicHandler(
    client as never,
    { getManager: () => ({ on: vi.fn(), players: { get: () => undefined } }) } as never,
    { getQueueInfo: () => QUEUE, is247: () => false, isKaraokeEnabled: () => false } as never,
  ) as unknown as HandlerView;

describe('the publisher consults asMessageChannel — accept direction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('edits the card for a genuine message manager', async () => {
    // The over-strict mutant killer. If the guard rejected a real channel the
    // card would simply never update — no error anywhere, just a frozen card.
    const edit = vi.fn().mockResolvedValue({});
    const channel = {
      isTextBased: () => true,
      messages: { cache: { get: () => ({ edit }) }, fetch: vi.fn() },
    };
    const handler = buildHandler({ on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } });
    await handler.publishProgress(buildPlayer());
    expect(edit).toHaveBeenCalledTimes(1);
    // A successful edit IS the fingerprint write — proof the publish committed.
    expect(handler.progressFingerprintsView.get('g-guard-1')).toBeTruthy();
  });

  it('fetches the message when the cache misses', async () => {
    const edit = vi.fn().mockResolvedValue({});
    const fetchMsg = vi.fn().mockResolvedValue({ edit });
    const channel = {
      isTextBased: () => true,
      messages: { cache: { get: () => undefined }, fetch: fetchMsg },
    };
    const handler = buildHandler({ on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } });
    await handler.publishProgress(buildPlayer());
    expect(fetchMsg).toHaveBeenCalledWith('msg-1');
    expect(edit).toHaveBeenCalledTimes(1);
  });
});

describe('the publisher consults asMessageChannel — reject direction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the publish and leaves the fingerprint unwritten when the manager is unusable', async () => {
    // The under-strict mutant killer. `messages` is present but `cache.get`
    // is not callable, so nothing may be read, nothing may be fetched, and —
    // the part that is easy to lose — the fingerprint must stay UNWRITTEN so
    // the next trigger (boundary timer, seek, chapter attach) retries instead
    // of the state being recorded as already published.
    const fetchMsg = vi.fn();
    const channel = { isTextBased: () => true, messages: { cache: {}, fetch: fetchMsg } };
    const handler = buildHandler({ on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } });
    await expect(handler.publishProgress(buildPlayer())).resolves.toBeUndefined();
    expect(fetchMsg).not.toHaveBeenCalled();
    expect(handler.progressFingerprintsView.has('g-guard-1')).toBe(false);
  });

  it('skips a non-text channel without reading its manager', async () => {
    const fetchMsg = vi.fn();
    const channel = {
      isTextBased: () => false,
      messages: { cache: { get: vi.fn() }, fetch: fetchMsg },
    };
    const handler = buildHandler({ on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } });
    await handler.publishProgress(buildPlayer());
    expect(fetchMsg).not.toHaveBeenCalled();
    expect(handler.progressFingerprintsView.has('g-guard-1')).toBe(false);
  });
});

const TRACK = {
  identifier: 'yt-guard-002',
  encoded: 'enc-guard',
  uri: 'https://youtube.com/watch?v=ytguard002',
  title: 'Esme',
  author: 'Mond',
  duration: 200000,
  sourceName: 'soundcloud',
  artworkUrl: 'https://img.test/esme.jpg',
};

const buildListeners = (client: unknown, colorService?: unknown) => {
  const host = {
    clearInactivityTimeout: vi.fn(),
    clearOkTimer: vi.fn(),
    clearCardTimers: vi.fn(),
    clearFallbackState: vi.fn(),
    clearKickGrace: vi.fn(),
    forgetNowPlaying: vi.fn(),
    updateChapterStatus: vi.fn(),
    armKaraokeTimer: vi.fn(),
    armChapterTimer: vi.fn(),
    swapChapterOnSeek: vi.fn(),
    scheduleImmediateProgress: vi.fn(),
    resolveKaraokeLines: vi.fn(async () => undefined),
    resolveVideoChapters: vi.fn(),
    chapterCardFor: vi.fn(() => null),
    lyricWindowFor: vi.fn(() => null),
    isSongExhausted: vi.fn(() => false),
    checkFallbackBudget: vi.fn(() => true),
    findAlternatePlayableTrack: vi.fn(async () => null),
    frozenPosition: vi.fn(() => 0),
    resumeFallbackAt: vi.fn(async () => undefined),
  };
  const queueService = {
    getQueueInfo: vi.fn(() => QUEUE),
    calculatePosition: vi.fn(() => 5000),
    recordTrackStart: vi.fn(),
    is247: vi.fn(() => false),
  };
  const listeners = new MusicEventListeners(
    host as never,
    { getManager: () => ({ on: vi.fn() }) } as never,
    queueService as never,
    client as never,
    colorService as never,
    undefined,
    undefined,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    new Map(),
  );
  return { listeners, host };
};

describe('the listeners consult asSendableChannel — accept direction', () => {
  it('posts the card and stores its id for a genuine channel', async () => {
    // Kills the over-strict mutant at the trackStart call site: a guard that
    // refuses a real channel loses the card AND every boundary timer, because
    // all of them are armed only after a successful post.
    const send = vi.fn(async () => ({ id: 'posted-1' }));
    const channel = { isTextBased: () => true, send, messages: { delete: vi.fn() } };
    const client = { on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } };
    const { listeners, host } = buildListeners(client);
    const store: Record<string, unknown> = {};
    const player = { ...buildPlayer(store), queue: { size: 0, isEmpty: true, unshift: vi.fn() } };
    await listeners.onTrackStart({} as never, player as never, TRACK as never);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.nowPlayingMessageId).toBe('posted-1');
    expect(host.armChapterTimer).toHaveBeenCalledTimes(1);
    expect(host.armKaraokeTimer).toHaveBeenCalledTimes(1);
  });
});

describe('the listeners consult asSendableChannel — reject direction', () => {
  it('posts nothing and arms nothing when send is not callable', async () => {
    // Kills `'send' in channel`. `send: undefined` is what a partial mock and
    // a half-initialised client look like; `in` says yes, then the call throws
    // and the listener swallows it as a card failure.
    const channel = { isTextBased: () => true, send: undefined, messages: { delete: vi.fn() } };
    const client = { on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } };
    const { listeners, host } = buildListeners(client);
    const store: Record<string, unknown> = {};
    const player = { ...buildPlayer(store), queue: { size: 0, isEmpty: true, unshift: vi.fn() } };
    await expect(listeners.onTrackStart({} as never, player as never, TRACK as never)).resolves.toBeUndefined();
    expect(store.nowPlayingMessageId).toBeUndefined();
    expect(host.armChapterTimer).not.toHaveBeenCalled();
    expect(host.armKaraokeTimer).not.toHaveBeenCalled();
  });

  it('deletes the previous card only through a callable delete', async () => {
    // Kills `'messages' in channel` on the delete-prev path: a manager that
    // exists without a callable `delete` must be skipped, not called.
    const deletePrev = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ id: 'posted-2' }));
    const channel = {
      isTextBased: () => true,
      send,
      messages: { delete: deletePrev },
    };
    const client = { on: vi.fn(), channels: { cache: new Map([['tc-1', channel]]), fetch: vi.fn() } };
    const { listeners } = buildListeners(client);
    const player = { ...buildPlayer(), queue: { size: 0, isEmpty: true, unshift: vi.fn() } };
    await listeners.onTrackStart({} as never, player as never, TRACK as never);
    expect(deletePrev).toHaveBeenCalledWith('msg-1');

    const noDelete = { isTextBased: () => true, send, messages: {} };
    const client2 = { on: vi.fn(), channels: { cache: new Map([['tc-1', noDelete]]), fetch: vi.fn() } };
    const { listeners: l2 } = buildListeners(client2);
    await expect(
      l2.onTrackStart({} as never, { ...buildPlayer(), queue: { size: 0, isEmpty: true, unshift: vi.fn() } } as never, TRACK as never),
    ).resolves.toBeUndefined();
    // Second post went through on a channel with NO message manager: the
    // delete-prev step skipped it and playback of the card went on. Nothing
    // threw, which is the whole difference from the `'messages' in channel`
    // check that used to land here.
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('the teardown listeners consult asDeletableChannel', () => {
  it('trackEnd skips a channel whose messages.delete is not callable', async () => {
    // Kills the same mutant on the trackEnd path. The observable difference
    // from a thrown delete is that nothing is retried and nothing is claimed.
    const client = {
      on: vi.fn(),
      channels: { cache: new Map(), fetch: vi.fn(async () => ({ messages: { delete: undefined } })) },
    };
    const { listeners, host } = buildListeners(client);
    const player = { ...buildPlayer(), queue: { size: 0, isEmpty: true, unshift: vi.fn() } };
    expect(() => listeners.onTrackEnd(player as never, TRACK as never, 'finished')).not.toThrow();
    expect(host.forgetNowPlaying).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(client.channels.fetch).toHaveBeenCalledWith('tc-1'));
  });

  it('playerDestroy skips a channel with no message manager at all', async () => {
    const client = {
      on: vi.fn(),
      channels: { cache: new Map(), fetch: vi.fn(async () => ({ id: 'tc-1' })) },
    };
    const { listeners } = buildListeners(client);
    const player = { ...buildPlayer(), queue: { size: 0, isEmpty: true, unshift: vi.fn() } };
    await expect(listeners.onPlayerDestroy(player as never)).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The host contract that replaced the casts
 * ------------------------------------------------------------------ */

type Hosts = {
  cards: { host: unknown };
  voice: { host: unknown };
  chapterArt: { host: unknown };
  karaoke: { host: unknown };
  listeners: { host: unknown };
  chapterTimeline: { host: unknown };
};

describe('MusicHandler passes ITSELF to every collaborator as the host', () => {
  it('hands the same live object to all six clusters', () => {
    // This is the assertion that would have failed against the old
    // `this as unknown as XHost` casts. Those silenced the only check that can
    // catch a renamed delegate, so a mismatch surfaced as a TypeError at the
    // first Moonlink event. `implements` moves it to build time; this pins the
    // runtime half — identity, not a wrapper or a proxy, because the suite
    // shadows methods as own properties on this exact object.
    const handler = new MusicHandler(
      { on: vi.fn(), channels: { cache: new Map() } } as never,
      { getManager: () => ({ on: vi.fn(), players: { get: () => undefined } }) } as never,
      { getQueueInfo: () => null, is247: () => false, isKaraokeEnabled: () => false } as never,
    );
    const hosts = handler as unknown as Hosts;
    for (const cluster of ['cards', 'voice', 'chapterArt', 'karaoke', 'listeners', 'chapterTimeline'] as const) {
      expect(hosts[cluster].host, `${cluster} must be handed the handler itself`).toBe(handler);
    }
  });

  it('keeps every host callback reachable as a replaceable member on the handler', () => {
    // The contract the extracted clusters depend on: they call back through
    // the host, so an own-property shadow (which is how the suite intercepts
    // them) must still take effect. If a member were captured by value into a
    // collaborator field this would silently stop working.
    const handler = new MusicHandler(
      { on: vi.fn(), channels: { cache: new Map() } } as never,
      { getManager: () => ({ on: vi.fn(), players: { get: () => undefined } }) } as never,
      { getQueueInfo: () => null, is247: () => false, isKaraokeEnabled: () => false } as never,
    );
    const mutable = handler as unknown as Record<string, unknown>;
    for (const member of [
      'publishProgress',
      'scheduleImmediateProgress',
      'forgetNowPlaying',
      'chapterCardFor',
      'lyricWindowFor',
      'updateChapterStatus',
      'armKaraokeTimer',
      'armChapterTimer',
      'clearCardTimers',
      'clearOkTimer',
      'clearKickGrace',
      'clearInactivityTimeout',
      'clearFallbackState',
      'forgetGuild',
    ]) {
      expect(typeof mutable[member], `${member} must be callable on the handler`).toBe('function');
      mutable[member] = vi.fn();
      expect(vi.isMockFunction(mutable[member]), `${member} must be shadowable as an own property`).toBe(true);
    }
  });

  it('reads artworkService and colorService live off the handler, not a captured copy', async () => {
    // Reassignment-after-construction is how the suite injects artwork. If a
    // collaborator captured the service by value, this card would render with
    // no cover and no test would notice.
    const handler = new MusicHandler(
      { on: vi.fn(), channels: { cache: new Map() } } as never,
      { getManager: () => ({ on: vi.fn(), players: { get: () => undefined } }) } as never,
      { getQueueInfo: () => null, is247: () => false, isKaraokeEnabled: () => false } as never,
    );
    const mutable = handler as unknown as { artworkService: unknown; getChapterCover: (...a: unknown[]) => Promise<string | null> };
    mutable.artworkService = { getTrackCoverUrl: async () => 'https://img.test/live.jpg' };
    await expect(mutable.getChapterCover('Rottweiler', 'Rottweiler', 'Joey')).resolves.toBe(
      'https://img.test/live.jpg',
    );
  });
});