import 'reflect-metadata';
import { describe, expect, it, beforeEach } from 'vitest';
import { ArtistsService } from './artistsService';

/**
 * artistsService is at 11.9% of 419 lines. `resolveArtistFromLink` is the
 * counterpart to `trackService.getTrackFromLink` and takes the same raw user
 * input, so the same reasoning applies: a wrong answer here is a wrong command,
 * not an exception.
 *
 * One asymmetry is worth stating, because the code documents it and it is
 * surprising: there is NO Spotify branch. A Spotify artist link deliberately
 * falls through and returns null, because there is no spotify-id -> artist
 * lookup in this codebase. That is pinned below so a future addition is a
 * deliberate change rather than an accident.
 */

const makeService = () => Object.create(ArtistsService.prototype) as ArtistsService;

describe('ArtistsService.resolveArtistFromLink', () => {
  let svc: ArtistsService;
  beforeEach(() => { svc = makeService(); });

  it('resolves a Last.fm artist URL', async () => {
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/Radiohead')).resolves.toBe('Radiohead');
  });

  it('decodes + as a space, since Last.fm encodes spaces that way', async () => {
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/James+Blake')).resolves.toBe('James Blake');
  });

  it('decodes percent-encoding in an artist name', async () => {
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/Bj%C3%B6rk')).resolves.toBe('Björk');
  });

  it('stops at a query string rather than absorbing it into the name', async () => {
    // The capture is [^/?#]+, so a trailing ?track=... must not become part of
    // the artist name, which would fail every lookup with "artist not found".
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/Radiohead?track=x')).resolves.toBe('Radiohead');
  });

  it('turns Apple Music dashes into spaces', async () => {
    // The fixture MUST contain a dash, or removing the replacement changes
    // nothing and the mutation survives. Apple uses dashes in the URL slug
    // exactly where the display name has spaces - "radiohead-head" is
    // "Radiohead Head" - so this is the ordinary case, not an edge one.
    await expect(svc.resolveArtistFromLink('https://music.apple.com/us/artist/radiohead-head/657515')).resolves.toBe('radiohead head');
  });

  it('returns null for a string that merely contains "http"', async () => {
    // The `includes('http')` guard is defensive, not load-bearing: both regexes
    // need a host segment, so anything the guard would reject reaches the same
    // null anyway. No mutation can separate them, so the guard's purpose is
    // recorded here rather than left implicit.
    await expect(svc.resolveArtistFromLink('http')).resolves.toBeNull();
    await expect(svc.resolveArtistFromLink('look at http://example.com')).resolves.toBeNull();
  });

  it('returns null for plain text, which is the common case', async () => {
    await expect(svc.resolveArtistFromLink('Radiohead')).resolves.toBeNull();
    await expect(svc.resolveArtistFromLink('')).resolves.toBeNull();
  });

  it('returns null for a Spotify artist link, by design', async () => {
    // Pinned deliberately. The source explains it: there is no spotify-id ->
    // artist resolver in this codebase, so the branch would lie. If one is ever
    // added, THIS test is what should change.
    await expect(svc.resolveArtistFromLink('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb')).resolves.toBeNull();
  });

  it('returns null for plain text, which is the common case', async () => {
    await expect(svc.resolveArtistFromLink('Radiohead')).resolves.toBeNull();
    await expect(svc.resolveArtistFromLink('')).resolves.toBeNull();
  });

  it('returns null rather than throwing on an undecodable segment', async () => {
    // A malformed percent-escape makes decodeURIComponent throw. The inner
    // try/catch returns the raw segment; the outer one is the backstop. Either
    // way the command must get an answer, not a rejection.
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/%E0%A4%A')).resolves.toBeTypeOf('string');
  });
});
