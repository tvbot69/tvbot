/**
 * The one HTML escaper and the one URL guard for the image generators.
 *
 * This file exists because the four copy-pasted escapers drifted: three escaped
 * `& < > "` and one also escaped `'`. The divergence was harmless *by accident* -
 * every current attribute is double-quoted (`src="${...}"`), so an unescaped
 * `'` cannot break out. It stays harmless only while that remains true, which is
 * exactly the kind of assumption that turns into a stored-XSS bug the day
 * someone writes `href='${...}'`. One implementation, escaping all five, removes
 * the question.
 */

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * `&` must be replaced first, otherwise the ampersands introduced by the later
 * replacements get double-escaped.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

/**
 * Allow a URL only if it is safe to place in an `src`/`href` attribute.
 *
 * The plan asked for "https only", but https-only would break this codebase:
 * `receiptGenerator` builds `data:image/png;base64,...` at runtime and the
 * render tests feed 1x1 `data:image/gif` placeholders in. So `data:` is allowed
 * for IMAGE subtypes only - `data:text/html` would be a genuine script vector
 * and is rejected. Plain `http` is rejected too, since every asset the bot has
 * is served over https and an http image is a mixed-content and MITM problem.
 *
 * Returns the input unchanged when allowed, or `null` when not, so the caller
 * has to decide what to render rather than silently emitting a broken card.
 */
export const safeUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const lower = trimmed.toLowerCase();

  // A URL containing raw whitespace is malformed. Without this check
  // `https://ok.example https://evil.example` passes the https test above
  // while carrying a second absolute URL inside it. Caught by a test, not by
  // reading the code.
  if (/\s/.test(trimmed)) return null;

  if (lower.startsWith('https://')) return trimmed;

  if (lower.startsWith('data:image/')) {
    // Reject `data:image/svg+xml` - SVG can carry script, so it is not a
    // safe image payload the way png/jpeg/gif/webp are.
    if (lower.startsWith('data:image/svg+xml')) return null;
    if (!lower.startsWith('data:image/png') &&
        !lower.startsWith('data:image/jpeg') &&
        !lower.startsWith('data:image/jpg') &&
        !lower.startsWith('data:image/gif') &&
        !lower.startsWith('data:image/webp')) {
      return null;
    }
    return trimmed;
  }

  return null;
};
