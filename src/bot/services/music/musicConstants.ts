/**
 * Shared music tuning constants.
 *
 * These values used to be duplicated as raw literals across musicHandler,
 * musicInteractions, moonlinkManager, musicService and the resolver files.
 * Duplicated invariants drift: the borrowed-cover window existed twice (and
 * had to be edited twice), and a queue cap lived in three files while
 * moonlink enforced a fourth, smaller one. Anything with a single meaning and
 * more than one consumer belongs here.
 */

/** Hard cap on the player queue. Also handed to Moonlink as its maxSize. */
export const MAX_QUEUE_TRACKS = 5000;

/**
 * How long a chapter may keep the PREVIOUS chapter's cover while its own art
 * resolves. Long enough to avoid a flash on a warm cache hit, short enough
 * that a chapter which never resolves stops showing a wrong song.
 */
export const BORROWED_COVER_MS = 15_000;

/** Retry window for a chapter whose cover could not be resolved. */
export const CHAPTER_ART_RETRY_MS = 30_000;

/**
 * Settle window for an implausible multi-chapter forward jump: the card holds
 * its current chapter for this long and re-derives once.
 */
export const CHAPTER_JUMP_CONFIRM_MS = 4_000;
/**
 * How long a recorded user-seek intent stays authoritative. `seek()` stamps
 * `lastUserSeekAt` before it awaits the node, so the chapter guard can tell
 * "the listener jumped here on purpose" from "this node's clock drifted".
 * Long enough to cover a slow seek REST round-trip, short enough that a later
 * spontaneous jump is still treated as drift.
 */
export const USER_SEEK_INTENT_WINDOW_MS = 30_000;
/**
 * How far BACK a position read may sit from the one a chapter was committed
 * at before it is treated as stale data rather than a rewind. Small on
 * purpose: a real backward seek is explained by a recorded seek intent, so
 * this only has to absorb clock jitter between readers.
 */
export const CHAPTER_REGRESSION_TOLERANCE_MS = 2_000;

/** Bound on a Lavalink search before another node is tried. */
export const SEARCH_TIMEOUT_MS = 8_000;

/** Bound on the resolver's loadTracks REST call. */
export const LOAD_TRACKS_TIMEOUT_MS = 8_000;

/** Bound on a user seek's REST round-trip; recovery is event-driven after. */
export const SEEK_REST_TIMEOUT_MS = 8_000;

/**
 * Floor for the karaoke boundary timer. Lyric lines sit seconds apart, so the
 * 1500ms floor the chapter timer uses would hold every dense line late by up
 * to a second and a half. 250ms stays above Node timer slack while keeping
 * the visible error under one beat.
 */
export const KARAOKE_TIMER_MIN_MS = 250;

/**
 * Lyric sync system: one lag, one cap, one tolerance. Single definitions
 * live in `syncedLyrics.ts` (the pure leaf); these re-export them so every
 * existing `musicConstants` import site keeps working without a second copy
 * to drift.
 *
 * Why no fixed 8700ms startup offset anymore: that number was measured once
 * (Geronimo, 123s, Home node, 2026-10-03) and then applied to every track on
 * every node. A track whose YouTube pressing runs longer than its LRC
 * pressing needs a bigger shift; one that matches needs almost none. Fixed
 * meant early on some songs and late on others, and the boundary timer armed
 * on the raw clock while the display read lagged — the two disagreed by the
 * full offset. The system now measures per track (duration-delta alignment,
 * capped) plus a small never-early safety lag, and timer and display share
 * the same effective position.
 */
export { LYRIC_SAFETY_LAG_MS, MAX_LYRIC_ALIGN_SHIFT_MS, LYRIC_MONOTONIC_TOLERANCE_MS } from '@bot/services/music/syncedLyrics';
