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
