/**
 * The one place `as unknown as` is allowed for Moonlink.
 *
 * Moonlink v5's published types describe the CLASS surface; the payloads it
 * actually sends at runtime carry more, and `player.current` is typed so
 * loosely that reading a documented field needs a cast. The plan permits those
 * casts in exactly one file so they can be reviewed together instead of
 * scattered across the music DAG.
 *
 * The rule that keeps this honest: every helper here NARROWS and returns
 * primitives or plain objects. A caller gets a real type back, so a renamed
 * field is a compile error at the call site - which is the whole point, and
 * what the inline casts made impossible.
 *
 * Import this with `import type` where only types are needed, so it cannot
 * become a runtime edge in the DAG (AGENTS.md rule 9).
 */

/** Fields the seek path writes back onto Moonlink's internal clock record. */
export interface MoonlinkClockFields {
  position?: number;
  time?: number;
}

/** The identity fields Moonlink uses for a track, in its own priority order. */
export interface MoonlinkTrackIdentity {
  encoded?: string;
  uri?: string;
  identifier?: string;
}

/** The timing fields our own artwork backfill stamps onto a track. */
export interface MoonlinkArtTiming {
  _artLookupStartedAt?: unknown;
  _artLookupResolvedAt?: unknown;
  _artLookupOutcome?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;


/**
 * Moonlink's internal clock record for the playing track, or null.
 *
 * The returned object is the LIVE record, not a copy: `onPlayerSeek` writes
 * `position`/`time` back onto it and Moonlink reads them. Copying would
 * silently stop the seek from taking effect.
 */
export const moonlinkClock = (track: unknown): MoonlinkClockFields | null =>
  asRecord(track) as MoonlinkClockFields | null;

/**
 * The stable identity of a track, following Moonlink's own fallback order.
 * Returns undefined when none of the three fields is a non-empty string.
 */
export const moonlinkTrackKey = (track: unknown): string | undefined => {
  const rec = asRecord(track);
  if (!rec) return undefined;
  for (const field of ['encoded', 'uri', 'identifier'] as const) {
    const value = rec[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

/** The upload source label, used only in the preview-cut warning. */
export const moonlinkSourceName = (track: unknown): string => {
  const value = asRecord(track)?.sourceName;
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
};

/** Our own artwork-lookup stamps, read for the `[art-timing]` log line. */
export const moonlinkArtTiming = (track: unknown): MoonlinkArtTiming =>
  (asRecord(track) ?? {}) as MoonlinkArtTiming;

/** Milliseconds since epoch, or null when the stamp is absent or not a number. */
export const artTimingNumber = (timing: MoonlinkArtTiming, field: keyof MoonlinkArtTiming): number | null => {
  const record = asRecord(timing);
  if (!record) return null;
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** The lookup outcome tag, defaulting the way the log line reads. */
export const artTimingOutcome = (timing: MoonlinkArtTiming): string => {
  const value = asRecord(timing)?._artLookupOutcome;
  return typeof value === 'string' && value.length > 0 ? value : 'no-lookup';
};

/**
 * Source labels the fallback ladder stamps onto an adopted alternate, so a
 * relabelled track reads as its new rung everywhere downstream.
 */
export interface MoonlinkSourceLabels {
  sourceName?: string;
  source?: string;
}

/**
 * Live source-label stash, or null when the track is not an object.
 *
 * Same live-record contract as `moonlinkClock`: the ladder WRITES through this
 * record and Moonlink (and `moonlinkSourceName`) read it back, so a copy would
 * silently drop the relabel.
 */
export const moonlinkSourceLabels = (track: unknown): MoonlinkSourceLabels | null =>
  asRecord(track) as MoonlinkSourceLabels | null;

/**
 * Chapter context our own code stashes onto a track BEFORE Spotify adoption
 * overwrites title/author: the raw video title and the source video id.
 *
 * Fields stay `unknown` deliberately — a partial mock, a vendor rename or a
 * half-built track must make the CALLER fall back, never crash here.
 */
export interface MoonlinkChapterStash {
  _rawVideoTitle?: unknown;
  _sourceVideoId?: unknown;
}

/** Live chapter-context stash, or null when the track is not an object. */
export const moonlinkChapterStash = (track: unknown): MoonlinkChapterStash | null =>
  asRecord(track) as MoonlinkChapterStash | null;

/** Narrow Moonlink/Discord message manager: read a card by id, never a raw cast. */
export interface MoonlinkMessageManager {
  cache: { get: (messageId: string) => unknown };
  fetch: (messageId: string) => Promise<unknown>;
}

/** Minimal channel shape that can resolve a message by id for editing. */
export interface MoonlinkMessageChannel {
  messages: MoonlinkMessageManager;
}

/**
 * True when the channel carries a usable message manager. Narrows to
 * `MoonlinkMessageChannel` so the publisher reads and edits a card without a
 * cast.
 *
 * Every level is checked, not just `messages`: a partial mock that has
 * `messages: {}` or a `cache` without `get` would otherwise pass and fail at
 * the call, turning a recoverable "cannot edit the card" into a thrown publish.
 * A non-function `get`/`fetch` is false.
 */
export const isMessageChannel = (channel: unknown): channel is MoonlinkMessageChannel => {
  const messages = asRecord(asRecord(channel)?.messages);
  if (!messages) return false;
  const cache = asRecord(messages.cache);
  return !!cache && typeof cache.get === 'function' && typeof messages.fetch === 'function';
};

/**
 * Extractor twins of the three channel predicates.
 *
 * They exist because narrowing IN PLACE is not usable here: Discord's
 * `TextBasedChannel` is a deferred conditional type
 * (`Exclude<Extract<Channel, …>>, …>`), and intersecting an unresolved
 * conditional union with a plain object type collapses the whole thing to
 * `never` — which reads as "this channel has no `send`", the opposite of the
 * truth. Reading the narrow value out into a separate binding keeps the guard
 * as the single decision point and the cast-free call sites honest.
 *
 * Semantics are exactly the predicates': null when the shape is not usable.
 */
export const asSendableChannel = (channel: unknown): MoonlinkSendableChannel | null =>
  isSendableChannel(channel) ? channel : null;

export const asDeletableChannel = (channel: unknown): MoonlinkDeletableChannel | null =>
  isDeletableChannel(channel) ? channel : null;

export const asMessageChannel = (channel: unknown): MoonlinkMessageChannel | null =>
  isMessageChannel(channel) ? channel : null;

/**
 * The node pool Moonlink keeps internally, for failover and resurrection.
 * Optional at every level because a half-initialised manager is a real state
 * during startup and must not throw here.
 */
export interface MoonlinkNodePool {
  nodes?: Map<string, unknown>;
  add?: (config: Record<string, unknown>) => void;
  remove?: (id: string) => boolean;
  findNode?: (opts?: { exclude?: string[] }) => unknown;
}

/**
 * Moonlink's internal `nodes` collection, or undefined.
 *
 * The double `asRecord` normalises null away: the declared return is
 * `| undefined`, and returning null leaked a value callers must guard twice.
 */
export const moonlinkNodePool = (manager: unknown): MoonlinkNodePool | undefined =>
  (asRecord(asRecord(manager)?.nodes) as MoonlinkNodePool | null) ?? undefined;

/** The raw node map, or undefined when the pool is absent or not a Map yet. */
export const moonlinkNodeMap = (manager: unknown): Map<string, unknown> | undefined => {
  const nodes = moonlinkNodePool(manager)?.nodes;
  return nodes instanceof Map ? nodes : undefined;
};

/**
 * Narrow shape of Moonlink's `player.current`.
 *
 * Moonlink types `current` loosely while the runtime payload carries the
 * documented track fields plus the mutable clock (`position`/`time`). Every
 * field stays optional because a half-built player during startup/teardown
 * is a real state and must not throw here.
 *
 * The returned object is the LIVE record, not a copy — same contract as
 * `moonlinkClock`. Callers that stamp `position`/`time` (pause/seek) write
 * through to Moonlink; copying would silently drop the write.
 */
export interface MoonlinkCurrentShape {
  identifier?: string;
  title?: string;
  author?: string;
  uri?: string;
  duration?: number;
  isStream?: boolean;
  isSeekable?: boolean;
  sourceName?: string;
  position?: number;
  time?: number;
}

/** `player.current` as a live record, or null when absent or not an object. */
export const moonlinkPlayerCurrent = (player: unknown): MoonlinkCurrentShape | null =>
  asRecord(asRecord(player)?.current) as MoonlinkCurrentShape | null;

/** Minimal Discord text-channel shape that can receive a card payload. */
export interface MoonlinkSendableChannel {
  send: (payload: unknown) => Promise<{ id: string }>;
}

/** Minimal Discord channel shape that can delete a prior card by id. */
export interface MoonlinkDeletableChannel {
  messages: { delete: (messageId: string) => Promise<unknown> };
}

/**
 * True when the channel carries a callable `send`. Narrows the unknown
 * channel to `MoonlinkSendableChannel` so callers post without a cast.
 * A non-function `send` (partial mock, half-initialised client) is false.
 */
export const isSendableChannel = (channel: unknown): channel is MoonlinkSendableChannel => {
  const rec = asRecord(channel);
  return !!rec && typeof rec.send === 'function';
};

/**
 * True when the channel carries `messages.delete`. Narrows to
 * `MoonlinkDeletableChannel` so callers delete the prior card without a
 * cast. A missing `messages` or non-function `delete` is false.
 */
export const isDeletableChannel = (channel: unknown): channel is MoonlinkDeletableChannel => {
  const messages = asRecord(asRecord(channel)?.messages);
  return !!messages && typeof messages.delete === 'function';
};

/**
 * Narrow requester shape stamped onto every queued track.
 *
 * Moonlink's `Track.requester` is untyped at runtime; a vendor upgrade that
 * renames `id` or nests it differently must surface as `undefined` here
 * (caller falls back to open-access) rather than a thrown read or a
 * fabricated id. Accepts both a bare requester (`{ id }`) and a track
 * carrying one (`{ requester: { id } }`).
 *
 * Returns a plain copy, not the live object: the requester is a value, and
 * the copy freezes `tag`/`avatarUrl` to strings present at read time.
 */
export interface MoonlinkRequesterShape {
  id: string;
  tag?: string;
  avatarUrl?: string;
}

/** Requester copy, or undefined when no usable non-empty string `id` exists. */
export const moonlinkRequester = (value: unknown): MoonlinkRequesterShape | undefined => {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const nested = asRecord(rec.requester) ?? rec;
  const id = nested.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const out: MoonlinkRequesterShape = { id };
  const tag = nested.tag;
  if (typeof tag === 'string' && tag.length > 0) out.tag = tag;
  const avatarUrl = nested.avatarUrl;
  if (typeof avatarUrl === 'string' && avatarUrl.length > 0) out.avatarUrl = avatarUrl;
  return out;
};

/** Requester id, or undefined when `moonlinkRequester` finds none. */
export const moonlinkRequesterId = (value: unknown): string | undefined =>
  moonlinkRequester(value)?.id;
