/**
 * Discord markdown escaping for user-supplied text.
 *
 * Track titles, artist names, album names, search queries, guild names and
 * video-chapter titles are all attacker-controllable (anyone can upload a
 * release called "**FREE** [click](https://evil.example)"). Interpolated raw
 * into a card, they restyle it, break layouts, or fake links. Mentions are
 * already handled separately via `allowedMentions: { parse: [] }`.
 *
 * Deliberately NOT escaped: `>`, `#`, `-` and digits at the start of a line
 * (blockquote/heading/list) — those only matter at line start, and escaping
 * them mangles ordinary titles like "Track - 2024". Everything that can
 * emphasise, strike, inline-code or link is escaped.
 */
const MARKDOWN_SPECIALS = /([\\*_~`|])/g;

/** Escape inline markdown. Safe to call on already-plain text. */
export const escapeMarkdown = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.replace(MARKDOWN_SPECIALS, '\\$1').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
};

/**
 * Escape for use inside a markdown LINK LABEL: `[label](url)`. The label needs
 * the same escaping, and the surrounding brackets must not survive or the link
 * breaks.
 */
export const escapeLinkLabel = (value: string | null | undefined): string =>
  escapeMarkdown(value).replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * Escape and clamp for a one-line context (embed field values, select
 * descriptions, button-adjacent labels).
 */
export const escapeInline = (value: string | null | undefined, maxLength = 100): string => {
  const escaped = escapeMarkdown(value).replace(/[\r\n]+/g, ' ');
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength - 1)}…` : escaped;
};
