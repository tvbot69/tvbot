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
const DURATION_TOLERANCE_MS = 15000;

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
): SyncedLine[] | null {
  if (!candidate || candidate.instrumental) return null;
  const lines = parseLrc(candidate.syncedLyrics);
  if (lines.length === 0) return null;
  if (
    expectedDurationMs !== undefined &&
    expectedDurationMs > 0 &&
    candidate.durationMs !== undefined &&
    candidate.durationMs > 0 &&
    Math.abs(candidate.durationMs - expectedDurationMs) > DURATION_TOLERANCE_MS
  ) {
    return null;
  }
  if (!lines.some((l) => l.text.length > 0)) return null;
  return lines;
}

/**
 * Karaoke window at a playback position: the last started line (current)
 * plus the next non-empty line. Holds the last pair through instrumental
 * gaps instead of blanking; before the first line, current is null.
 *
 * `startupOffsetMs` compensates the node startup gap (card/clock starts at
 * the trackStart event, audible audio follows seconds later while the
 * stream connects). The lookup runs behind the clock by that amount so the
 * shown line matches what is actually heard.
 */
export function lyricWindowAt(
  lines: SyncedLine[] | null | undefined,
  positionMs: number,
  startupOffsetMs: number = 0,
): LyricWindow | null {
  if (!lines || lines.length === 0) return null;
  const effective = Math.max(0, positionMs - Math.max(0, startupOffsetMs));
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
