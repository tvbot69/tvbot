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
