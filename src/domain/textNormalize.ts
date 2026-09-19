const ZERO_WIDTH_PATTERN = new RegExp(
  `[${String.fromCharCode(0x200b, 0x200c, 0x200d, 0xfeff)}]`,
  'g',
);

/**
 * Storage normalization for scrobbled names (artists, albums, tracks).
 * Prevents history splits like "Mond" vs "Mond " vs "Mo  nd" across index and
 * delta ingest. Deliberately conservative — casing is preserved (queries match
 * case-insensitively); only invisible/structural noise is removed.
 */
export const normalizeStoredName = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.replace(ZERO_WIDTH_PATTERN, '').replace(/\s+/g, ' ').trim();
};
