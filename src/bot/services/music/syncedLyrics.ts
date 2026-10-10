/**
 * Synced-lyrics primitives for the live karaoke card. Pure functions only —
 * fetching and caching live in LyricsService; display lives in the builders.
 */

export interface SyncedLine {
  /** Milliseconds from track start. */
  ms: number;
  text: string;
}

export interface LyricWindow {
  /** Line being sung right now (null before the first line). */
  current: string | null;
  /** Next non-empty line (null when nothing follows). */
  next: string | null;
}

export interface SyncedCandidate {
  syncedLyrics?: string;
  instrumental?: boolean;
  /** Track length in ms when the provider reported one. */
  durationMs?: number;
}

const LRC_LINE_RE = /^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/;
/** Pressings farther apart than this never share a clock; nearer ones still can. */
export const DURATION_TOLERANCE_MS = 15000;

/**
 * Lyric sync system tuning. Three numbers, each with one job:
 *
 * - SAFETY_LAG: the card and the boundary timer both run BEHIND the node
 *   clock by this much, so a line is never shown before it is heard. Covers
 *   timer slack (250ms floor), Discord edit round-trip and voice jitter.
 *   Late by a beat reads as karaoke; early by a beat reads as broken.
 * - ALIGN_SHIFT cap: per-track arrangement correction (YouTube intro vs LRC
 *   pressing) is measured from the duration delta, never guessed, and capped
 *   here so a bad duration cannot teleport the whole clock.
 * - MONOTONIC tolerance: a position that moves backwards past this with no
 *   recorded seek intent is stale node data, not a rewind — the window holds.
 */
export const LYRIC_SAFETY_LAG_MS = 1200;
export const MAX_LYRIC_ALIGN_SHIFT_MS = 10000;
export const LYRIC_MONOTONIC_TOLERANCE_MS = 2000;

/**
 * Pressing gate for LIVE performances. A live arrangement re-times lines
 * (intros, banter, tempo shifts) far beyond its duration delta, so a studio
 * clock 8s away in length can sit seconds off all song. Live-tagged tracks
 * get 5s; anything farther apart is doubt, and doubt shows no lyrics
 * rather than wrong ones.
 */
export const LIVE_DURATION_TOLERANCE_MS = 5000;

const LIVE_RE = /\b(live|unplugged|acoustic|audiotree|kexp|tiny desk|mahogany|sessions?|concert|on tour|live version|live at|vevo live)\b/i;

/**
 * Whether the RAW provider-facing title/album names a live performance.
 * Runs pre-clean: the query sanitizer strips bracketed tags like
 * "(Live Version)", so the cleaned title no longer says live.
 * Artist is deliberately excluded (a band named Live is not a concert).
 */
export function isLivePerformance(title: string, album?: string): boolean {
  return LIVE_RE.test(title) || (typeof album === 'string' && LIVE_RE.test(album));
}

/**
 * Parses LRC text (`[mm:ss.xx] lyric` per line) into timestamped lines.
 * Empty-text lines are kept (they mark instrumental gaps for the window
 * logic to hold on). Malformed lines are dropped.
 */
export function parseLrc(text: string | undefined | null): SyncedLine[] {
  if (!text) return [];
  const lines: SyncedLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = LRC_LINE_RE.exec(line);
    if (!m) continue;
    const minutes = Number(m[1]);
    const seconds = Number(m[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
    lines.push({ ms: Math.round(minutes * 60000 + seconds * 1000), text: (m[3] ?? '').trim() });
  }
  lines.sort((a, b) => a.ms - b.ms);
  return lines;
}

/**
 * Selects usable synced lines for a track: needs synced text, must not be
 * instrumental, and the provider-reported duration must roughly match ours
 * (wrong-version timings are worse than no lyrics). Returns null otherwise.
 */
export function selectSynced(
  candidate: SyncedCandidate | null | undefined,
  expectedDurationMs?: number,
  toleranceMs: number = DURATION_TOLERANCE_MS,
): SyncedLine[] | null {
  if (!candidate || candidate.instrumental) return null;
  const lines = parseLrc(candidate.syncedLyrics);
  if (lines.length === 0) return null;
  if (
    expectedDurationMs !== undefined &&
    expectedDurationMs > 0 &&
    candidate.durationMs !== undefined &&
    candidate.durationMs > 0 &&
    Math.abs(candidate.durationMs - expectedDurationMs) > toleranceMs
  ) {
    return null;
  }
  if (!lines.some((l) => l.text.length > 0)) return null;
  return lines;
}

/**
 * Per-track arrangement alignment: when the audio actually playing runs
 * longer than the LRC pressing (extra YouTube intro, longer silence), every
 * LRC timestamp sits early relative to what is heard by roughly the duration
 * delta. Shift the whole clock forward by that delta so the shown line
 * matches the heard line. Only ever shifts FORWARD (never shows earlier)
 * and caps at MAX_LYRIC_ALIGN_SHIFT_MS so a bad duration cannot teleport
 * the clock. A shorter playing track leaves the clock untouched: shifting
 * backwards would show lines before they are sung.
 */
export function alignSyncedLines(
  lines: SyncedLine[],
  candidateDurationMs?: number,
  expectedDurationMs?: number,
): { lines: SyncedLine[]; shiftMs: number } {
  if (!lines || lines.length === 0) return { lines, shiftMs: 0 };
  if (
    candidateDurationMs === undefined ||
    expectedDurationMs === undefined ||
    !Number.isFinite(candidateDurationMs) ||
    !Number.isFinite(expectedDurationMs) ||
    candidateDurationMs <= 0 ||
    expectedDurationMs <= 0
  ) {
    return { lines, shiftMs: 0 };
  }
  const delta = expectedDurationMs - candidateDurationMs;
  const shift = Math.max(0, Math.min(delta, MAX_LYRIC_ALIGN_SHIFT_MS));
  if (shift <= 0) return { lines, shiftMs: 0 };
  return { lines: lines.map((l) => ({ ms: l.ms + Math.round(shift), text: l.text })), shiftMs: Math.round(shift) };
}

/**
 * Next lyric boundary after an effective position, or null when the track
 * has sung its last line. Timer and display share this: the timer arms to
 * `next.ms - effective`, the display derives from the same effective, so
 * the two can never disagree about which line is next.
 */
export function nextLyricBoundary(
  lines: SyncedLine[] | null | undefined,
  effectiveMs: number,
): SyncedLine | null {
  if (!lines || lines.length === 0) return null;
  for (const line of lines) {
    if (line.ms > effectiveMs) return line;
  }
  return null;
}

/**
 * Effective lyric position: node clock minus the safety lag. One function so
 * the window lookup and the boundary timer compute the same value from the
 * same inputs — a timer armed on raw position while the display reads lagged
 * fires a full lag early and shows the wrong line.
 */
export function lyricEffectiveAt(positionMs: number, safetyLagMs: number = LYRIC_SAFETY_LAG_MS): number {
  return Math.max(0, positionMs - Math.max(0, safetyLagMs));
}

/**
 * Karaoke window at a playback position: the last started line (current)
 * plus the next non-empty line. Holds the last pair through instrumental
 * gaps instead of blanking; before the first line, current is null.
 *
 * `safetyLagMs` runs the lookup behind the node clock so the shown line
 * matches what is actually heard (timer slack, edit round-trip, voice
 * jitter). Lines themselves are pre-aligned per track by
 * `alignSyncedLines`; this lag is the never-early guarantee on top.
 */
export function lyricWindowAt(
  lines: SyncedLine[] | null | undefined,
  positionMs: number,
  safetyLagMs: number = 0,
): LyricWindow | null {
  if (!lines || lines.length === 0) return null;
  const effective = lyricEffectiveAt(positionMs, safetyLagMs);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.ms ?? Number.MAX_SAFE_INTEGER) <= effective) idx = i;
    else break;
  }
  let current: string | null = null;
  let currentIdx = -1;
  for (let i = idx; i >= 0; i--) {
    const text = lines[i]?.text ?? '';
    if (text.length > 0) {
      current = text;
      currentIdx = i;
      break;
    }
  }
  let next: string | null = null;
  for (let i = Math.max(currentIdx + 1, idx + 1); i < lines.length; i++) {
    const text = lines[i]?.text ?? '';
    if (text.length > 0) {
      next = text;
      break;
    }
  }
  if (current === null && next === null) return null;
  return { current, next };
}
