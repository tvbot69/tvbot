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
 * Titles that describe the video container rather than a song. Showing
 * "Now: Intro" is silly, so these suppress the chapter card (the normal
 * card + artist fallback carry on underneath).
 */
const GENERIC_TOKENS = [
  'intro', 'outro', 'introduction', 'start', 'end', 'ending', 'opening', 'closing',
  'credits', 'intermission', 'interlude', 'crowd', 'applause', 'encore', 'prologue',
  'epilogue', 'preview', 'snippet', 'teaser', 'announcement', 'talk',
];

export function isGenericChapterTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim().toLowerCase();
  if (!t) return true;
  return GENERIC_TOKENS.some((g) => t === g || t.startsWith(`${g} `) || t.startsWith(`${g}-`) || t.endsWith(` ${g}`));
}

/**
 * Splits a chapter title into artist + song for artwork lookup.
 * "EsDeeKid - Rottweiler" -> both; "Rottweiler" -> song only (caller falls
 * back to the video author). Leading track numbers ("01. X") are stripped.
 */
export function splitChapterTitle(title: string): { artist?: string; song: string } {
  const cleaned = title
    .trim()
    .replace(/^\d{1,3}[.)\s:-]+/, '')
    .trim();
  const dash = cleaned.indexOf(' - ');
  if (dash > 0) {
    const artist = cleaned.slice(0, dash).trim();
    const song = cleaned.slice(dash + 3).trim();
    if (artist && song) return { artist, song };
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
  const dash = t.indexOf(' - ');
  if (dash <= 0) return null;
  const candidate = t
    .slice(0, dash)
    .replace(/^\d{1,3}[.)\s:-]+/, '')
    .trim();
  if (candidate.length < 2) return null;
  if (/^(live|full|official|video|audio|performance|set|show|concert|mix|playlist|visualizer|lyric|stream)$/i.test(candidate)) {
    return null;
  }
  return candidate;
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
