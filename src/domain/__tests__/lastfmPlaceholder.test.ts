// Must be first: the identity assertion below imports artworkService, which is
// tsyringe-decorated, and AGENTS.md section 5 requires this ordering.
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { isPlaceholderImageUrl } from '@domain/lastfmPlaceholder';
import { isPlaceholderImageUrl as viaArtworkService } from '@bot/services/media/artworkService';

describe('isPlaceholderImageUrl', () => {
  it('detects the Last.fm no-image hash', () => {
    expect(
      isPlaceholderImageUrl('https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png'),
    ).toBe(true);
  });

  it('accepts a real image URL', () => {
    expect(isPlaceholderImageUrl('https://i.scdn.co/image/ab67616d0000b273abcdef0123456789')).toBe(false);
  });

  it('treats missing as a placeholder, so `!isPlaceholder(...)` rejects it', () => {
    // The asymmetry is the point: a null cover must not be treated as real art.
    expect(isPlaceholderImageUrl(null)).toBe(true);
    expect(isPlaceholderImageUrl(undefined)).toBe(true);
    expect(isPlaceholderImageUrl('')).toBe(true);
  });

  it('is the SAME function artworkService exports, not a second copy', () => {
    // AGENTS.md golden rule 2: exactly one predicate. If artworkService ever
    // re-defines it, this fails and the two drift apart again.
    expect(viaArtworkService).toBe(isPlaceholderImageUrl);
  });
});
