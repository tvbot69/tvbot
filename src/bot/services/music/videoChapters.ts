/**
 * Video-chapter primitives for live-show cards (lives, mixes, DJ sets).
 * Pure functions only — fetching lives in the resolver + ytResolver client,
 * per-chapter artwork in the ArtworkService cascade, display in builders.
 */

export interface VideoChapter {
  title: string;
  startMs: number;
}

/** Display-ready chapter card stored on the player. */
export interface ChapterCard {
  title: string;
  artworkUrl?: string | null;
}

/**
 * Live-performance threshold: the chapter / long-form system is standalone
 * and fires ONLY for videos longer than this (full sets, concerts, DJ
 * mixes). Short tracks and Spotify-link plays never enter it — their
 * artwork and metadata paths are untouched.
 */
export const LIVE_VIDEO_THRESHOLD_MS = 20 * 60 * 1000;

export function isLiveVideo(durationMs: number | null | undefined): boolean {
  return typeof durationMs === 'number' && durationMs > LIVE_VIDEO_THRESHOLD_MS;
}

/**
 * Applies the hold-last-cover rule: a chapter still waiting on its art
 * keeps the previously displayed cover instead of flashing generic track
 * art and swapping again when the real cover lands. Returns the card to
 * render plus the effective cover (also persisted as the next hold).
 */
export function resolveDisplayedChapter(
  chapter: ChapterCard | null,
  lastCoverUrl: string | null,
  trackArtworkUrl?: string | null,
): { card: ChapterCard | null; shownCover: string | null } {
  let display = chapter;
  if (chapter && !chapter.artworkUrl && lastCoverUrl) {
    display = { title: chapter.title, artworkUrl: lastCoverUrl };
  }
  const shownCover = display?.artworkUrl ?? trackArtworkUrl ?? null;
  return { card: display, shownCover };
}

/**
 * Titles that describe the video container rather than a song. Showing
 * "Now: Intro" is silly, so these suppress the chapter card (the normal
 * card + artist fallback carry on underneath).
 */
const GENERIC_TOKENS = [
  'intro', 'outro', 'introduction', 'start', 'end', 'ending', 'opening', 'closing',
  'credits', 'intermission', 'interlude', 'crowd', 'applause', 'encore', 'prologue',
  'epilogue', 'preview', 'snippet', 'teaser', 'announcement', 'talk',
];

function isGenericSingleTitle(t: string): boolean {
  return GENERIC_TOKENS.some((g) => t === g || t.startsWith(`${g} `) || t.startsWith(`${g}-`) || t.endsWith(` ${g}`));
}

export function isGenericChapterTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim().toLowerCase();
  if (!t) return true;
  // Slash/pipe-joined container titles ("Intro/Outro") are common on YouTube.
  // All parts must be generic to suppress — "Intro / Real Song" still shows.
  if (/[/|]/.test(t)) {
    const parts = t
      .split(/[/|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return true;
    return parts.every((p) => isGenericSingleTitle(p));
  }
  return isGenericSingleTitle(t);
}

/**
 * Splits a chapter title into artist + song for artwork lookup.
 * "EsDeeKid - Rottweiler" -> both; "Rottweiler" -> song only (caller falls
 * back to the video author). Leading track numbers ("01. X") are stripped.
 */
/** Matches " - " plus en/em-dash variants ("Rihanna – Diamonds"). */
const DASH_SEP = /\s[-–—]\s/;

/**
 * Right-hand side that describes the performance rather than naming a song
 * ("SICKO MODE - Live", "BUTTERFLY EFFECT - Live Version", "FE!N - Live at
 * Glastonbury"). Splitting those as artist="SICKO MODE" / song="Live"
 * guarantees an artwork miss; the song is the left side.
 */
const isPerformanceSuffix = (value: string): boolean => {
  const t = value
    .trim()
    .toLowerCase()
    .replace(/[!.?]+$/, '');
  if (
    t === 'live' ||
    t === 'acoustic' ||
    t === 'live version' ||
    t === 'live session' ||
    t === 'live performance' ||
    t === 'live recording' ||
    t === 'live set' ||
    t === 'acoustic version'
  ) {
    return true;
  }
  return t.startsWith('live at ') || t.startsWith('live in ') || t.startsWith('live from ');
};

export function splitChapterTitle(title: string): { artist?: string; song: string } {
  const cleaned = title
    .trim()
    .replace(/^\d{1,3}[.):-]+/, '')
    .trim();
  const m = DASH_SEP.exec(cleaned);
  if (m && m.index > 0) {
    const artist = cleaned.slice(0, m.index).trim();
    const song = cleaned.slice(m.index + m[0].length).trim();
    if (artist && song) {
      if (isPerformanceSuffix(song)) return { song: artist };
      return { artist, song };
    }
  }
  return { song: cleaned };
}

/**
 * Extracts the artist from a VIDEO title ("EsDeeKid - Live at Silver
 * Spring [FULL SET]" -> "EsDeeKid"). Uploader channels often differ from
 * the performer (a "gloss" channel uploading an EsDeeKid set), in which
 * case the author-based lookup misses while the title names the artist.
 * Returns null when no artist-like prefix exists. Callers validate via the
 * cascade's strict name matching, so a wrong guess just misses.
 */
export function extractArtistFromTitle(title: string | null | undefined): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  const m = DASH_SEP.exec(t);
  if (!m || m.index <= 0) return null;
  const candidate = t
    .slice(0, m.index)
    .replace(/^\d{1,3}[.):-]+/, '')
    .trim();
  if (candidate.length < 2) return null;
  if (/^(live|full|official|video|audio|performance|set|show|concert|mix|playlist|visualizer|lyric|stream)$/i.test(candidate)) {
    return null;
  }
  return stripTrailingSetNoise(candidate);
}

/**
 * Artist segments in video titles commonly end with set-type noise
 * ("TRAVIS SCOTT LIVE - ...", "Drake FULL SET - ..."). Artwork providers
 * gate on strict artist equality, so a trailing "LIVE" makes every chapter
 * lookup miss (measured on Spotify: artist:"TRAVIS SCOTT LIVE" = 0 hits,
 * artist:"TRAVIS SCOTT" = the song). Strips the noise run; null when
 * nothing but noise remains.
 */
const TRAILING_SET_NOISE = /(?:\s+(?:live|full|official|set|show|concert|performance|mix|stream|session|tour|episode))+$/i;

function stripTrailingSetNoise(candidate: string): string | null {
  const stripped = candidate.replace(TRAILING_SET_NOISE, '').trim();
  if (stripped.length < 2) return null;
  if (/^(live|full|official|video|audio|performance|set|show|concert|mix|playlist|visualizer|lyric|stream)$/i.test(stripped)) {
    return null;
  }
  return stripped;
}

/**
 * Raw YouTube video title stashed before Spotify adoption overwrites
 * title/author. Spotify titles ("Diamonds") carry no " - " separator, so
 * reading player.current.title directly silently loses the video-artist
 * fallback. Callers must read through this helper.
 */
export function getVideoTitle(track: { title?: string } | null | undefined): string | null {
  if (!track) return null;
  const raw = (track as unknown as { _rawVideoTitle?: unknown })._rawVideoTitle;
  if (typeof raw === 'string' && raw.trim()) return raw;
  return track.title ?? null;
}

/**
 * Video ID for chapter probing. YouTube-rung tracks carry it as the
 * identifier; resolver-served local files carry the stamped
 * `_sourceVideoId` (the resolver's input ID, never copied back before).
 */
export function getSourceVideoId(
  track: { sourceName?: string; identifier?: string } | null | undefined,
): string | null {
  if (!track) return null;
  const stamped = (track as unknown as { _sourceVideoId?: unknown })._sourceVideoId;
  if (typeof stamped === 'string' && /^[\w-]{11}$/.test(stamped)) return stamped;
  const id = track.identifier ?? '';
  if (!/^[\w-]{11}$/.test(id)) return null;
  if (track.sourceName === 'youtube' || track.sourceName === 'spotify') return id;
  return null;
}

/**
 * Index of the chapter playing at a position (last chapter started at or
 * before it). -1 when there are no usable chapters. `startupOffsetMs`
 * reuses the karaoke clock correction (card clock runs ahead of audible
 * audio while the stream connects).
 */
export function chapterIndexAt(
  chapters: VideoChapter[] | null | undefined,
  positionMs: number,
  startupOffsetMs: number = 0,
): number {
  if (!chapters || chapters.length < 2) return -1;
  const effective = Math.max(0, positionMs - Math.max(0, startupOffsetMs));
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    const start = chapters[i]?.startMs;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) continue;
    if (start <= effective) idx = i;
    else break;
  }
  return idx;
}
