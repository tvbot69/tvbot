import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SpotifyResolver } from '@bot/services/music/spotifyResolver';

/**
 * spotifyResolver is at 10.8% of 343 lines. `isSpotifyUrl` and
 * `parseSpotifyUrl` are pure and gate every other path in the resolver, so
 * everything downstream depends on them being right about which links this bot
 * claims to handle.
 *
 * The repeated-call test at the end is the one worth reading. `RegExp.test`
 * advances `lastIndex` on a GLOBAL regex, so adding `g` to SPOTIFY_URL_REGEX
 * would make this alternate true, false, true, false across calls - and the
 * failure would be intermittent and load-dependent rather than deterministic.
 * There is a comment on the regex about the `/intl-xx/` form; there was nothing
 * pinning the absence of `g`, and nothing that would have failed when someone
 * added it.
 */

const makeResolver = () => {
  const tokenManager = { getToken: vi.fn(async () => null) };
  return new SpotifyResolver(tokenManager as never);
};

describe('SpotifyResolver.isSpotifyUrl', () => {
  let r: SpotifyResolver;
  beforeEach(() => { r = makeResolver(); });

  it.each(['track', 'album', 'playlist', 'artist'])('accepts a /%s/ link', (type) => {
    expect(r.isSpotifyUrl(`https://open.spotify.com/${type}/4Z8W4fKeB5YxbusRsdQVPb`)).toBe(true);
  });

  it('accepts the localised /intl-xx/ path', () => {
    // Spotify serves these to users outside the default region, so this is the
    // shape a meaningful share of pasted links actually has.
    expect(r.isSpotifyUrl('https://open.spotify.com/intl-de/track/3n3Ppam7vgaVa1iaRUc9Lp')).toBe(true);
  });

  it('accepts the spotify: URI form', () => {
    // What the desktop client and the mobile app hand over through the share
    // sheet.
    expect(r.isSpotifyUrl('spotify:track:3n3Ppam7vgaVa1iaRUc9Lp')).toBe(true);
  });

  it('is case-insensitive, because links arrive uppercased by some clients', () => {
    expect(r.isSpotifyUrl('HTTPS://OPEN.SPOTIFY.COM/TRACK/3n3Ppam7vgaVa1iaRUc9Lp')).toBe(true);
  });

  it('trims surrounding whitespace from a pasted link', () => {
    expect(r.isSpotifyUrl('  https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp  ')).toBe(true);
  });

  it('would still match a padded link if trim() were removed', () => {
    // The regex is UNANCHORED - it looks for the host anywhere in the string -
    // so `.trim()` is redundant rather than load-bearing, and removing it
    // changes no observable behaviour. That is why the mutation survives, and
    // it is recorded here so the redundancy is a decision and not an oversight.
    //
    // The trade-off is worth stating: because the regex is unanchored, the
    // lookalike-domain test below is the ONLY thing stopping a phishing mirror
    // of spotify.com from being accepted. Anchoring the pattern would make
    // trim() meaningful and that test unnecessary, and is the better long-term
    // shape.
    expect(r.isSpotifyUrl('  https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp  ')).toBe(true);
    expect(r.isSpotifyUrl('\nhttps://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp\n')).toBe(true);
  });

  it('rejects a non-Spotify URL', () => {
    expect(r.isSpotifyUrl('https://www.last.fm/music/Radiohead')).toBe(false);
    expect(r.isSpotifyUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });

  it('rejects a Spotify lookalike domain', () => {
    // Without the host being anchored, a phishing mirror of spotify.com would
    // be treated as a real link and the resolver would call Spotify with an id
    // the user did not intend to share.
    expect(r.isSpotifyUrl('https://open.spotify.com.evil.example/track/3n3Ppam7vgaVa1iaRUc9Lp')).toBe(false);
    expect(r.isSpotifyUrl('https://notspotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp')).toBe(false);
  });

  it('returns the same answer on every repeated call', () => {
    // A `g` flag on the shared regex would make these alternate. Asserted
    // explicitly because nothing else would notice.
    const url = 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp';
    for (let i = 0; i < 6; i++) {
      expect(r.isSpotifyUrl(url)).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      expect(r.isSpotifyUrl('https://example.com/nope')).toBe(false);
    }
  });
});

describe('SpotifyResolver.parseSpotifyUrl', () => {
  let r: SpotifyResolver;
  beforeEach(() => { r = makeResolver(); });

  it('extracts the type and id from a track link', () => {
    expect(r.parseSpotifyUrl('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp')).toEqual({
      type: 'track',
      id: '3n3Ppam7vgaVa1iaRUc9Lp',
    });
  });

  it.each(['album', 'playlist', 'artist'])('extracts type "%s"', (type) => {
    expect(r.parseSpotifyUrl(`https://open.spotify.com/${type}/4Z8W4fKeB5YxbusRsdQVPb`)).toEqual({
      type,
      id: '4Z8W4fKeB5YxbusRsdQVPb',
    });
  });

  it('parses the spotify: URI form', () => {
    expect(r.parseSpotifyUrl('spotify:album:4LH4d3cOWNNXdsqFd42wum')).toEqual({
      type: 'album',
      id: '4LH4d3cOWNNXdsqFd42wum',
    });
  });

  it('ignores a query string after the id', () => {
    // Share links carry ?si=<token>, and absorbing it would make the id
    // invalid, so every resolve would 404.
    expect(r.parseSpotifyUrl('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abc123')).toEqual({
      type: 'track',
      id: '3n3Ppam7vgaVa1iaRUc9Lp',
    });
  });

  it('returns null for a URL that is not Spotify', () => {
    expect(r.parseSpotifyUrl('https://www.last.fm/music/Radiohead')).toBeNull();
    expect(r.parseSpotifyUrl('just some text')).toBeNull();
    expect(r.parseSpotifyUrl('')).toBeNull();
  });

  it('returns a null id rather than a truncated one for a malformed link', () => {
    // https://open.spotify.com/track/ with nothing after it must not resolve to
    // an empty id that then gets requested.
    expect(r.parseSpotifyUrl('https://open.spotify.com/track/')).toBeNull();
  });

  it('is stable across repeated calls', () => {
    const url = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
    const first = r.parseSpotifyUrl(url);
    for (let i = 0; i < 5; i++) {
      expect(r.parseSpotifyUrl(url)).toEqual(first);
    }
  });
});
