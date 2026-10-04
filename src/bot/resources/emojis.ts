/**
 * Every custom Discord emoji this bot renders, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The same literal was pasted at up to ELEVEN call sites:
 *
 *   .setEmoji({ id: '883825508087922739', name: 'pages_next' })
 *
 * 62 such casts existed across the codebase. Three problems, in order of
 * severity:
 *
 *  1. The ID was duplicated, so changing or fixing a page-button emoji meant
 *     editing eleven lines in eleven files, and missing one gives the button a
 *     blank emoji on exactly one page of exactly one command.
 *  2. The `as any` was never necessary. `setEmoji` accepts
 *     `ComponentEmojiResolvable = APIMessageComponentEmoji | string`, and
 *     `{ id, name }` satisfies it structurally. Verified with tsc before
 *     removing a single cast: the object literal compiles with no cast at all.
 *     So the casts were cargo cult that the compiler never asked for.
 *  3. Nothing recorded which emoji belonged to what, so the `sp` / `las` / `yt`
 *     service icons and the `pages_*` paginator buttons were indistinguishable
 *     at the call site.
 *
 * The constants are `as const`, so each keeps its literal type and a typo in an
 * id is a compile error rather than a blank button in production.
 */

/** Custom emoji, shaped the way discord.js accepts it. */
export interface CustomEmoji {
  readonly id: string;
  readonly name: string;
}

/** Paginator controls. Shared by every paginated response in the bot. */
export const EMOJI = {
  pageNext: { id: '883825508087922739', name: 'pages_next' },
  pagePrevious: { id: '883825508507336704', name: 'pages_previous' },
  pageFirst: { id: '883825508633182208', name: 'pages_first' },
  pageLast: { id: '883825508482183258', name: 'pages_last' },
  pageGoto: { id: '1138849626234036264', name: 'pages_goto' },

  /** Last.fm service badges. */
  serviceLastFm: { id: '1496297104434270290', name: 'las' },
  serviceSpotify: { id: '1496297132381048995', name: 'sp' },
  serviceDeezer: { id: '1496297153717473311', name: 'dez' },
  serviceAppleMusic: { id: '1496297174869479548', name: 'am' },
  serviceYouTube: { id: '1496297072201040094', name: 'yt' },
  serviceInstagram: { id: '1499324552201633862', name: 'inst' },
  serviceBandcamp: { id: '1499324758364524595', name: 'bnd' },

  /** Playback and misc. */
  playPreview: { id: '1305607890941378672', name: 'fmbot_playpreview' },

  /** Rating stars, matched to the RYM 1-5 scale. */
  starFull: { id: '1556308224917905498', name: 'fullstar' },
  starHalf: { id: '1556308385333383179', name: 'halfstar' },
  starQuarter: { id: '1556308489838526584', name: 'quarterstar' },
  add: { id: '1483232894318149692', name: 'plus' },
  appleMusicServices: { id: '1218182727149420544', name: 'services_apple_music' },
  cross: { id: '1499324577786892308', name: 'x_' },
  info: { id: '1183840696457777153', name: 'fmbot_info' },
} as const satisfies Record<string, CustomEmoji>;
