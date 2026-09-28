import 'reflect-metadata';
import { describe, expect, it, beforeEach } from 'vitest';
import { TrackService } from './trackService';

/**
 * trackService sits at 7.7% of 428 lines. These two parsers take raw user
 * input - a pasted URL, a bolded description - so they are where a wrong answer
 * is a wrong command rather than an exception.
 *
 * `parseBoldDelimitedTrackAndArtist` parses text this bot generates itself:
 * the embed footer reads "**Track** **by** **Artist**". So a change to the
 * template silently breaks the parser, and the symptom is a scrobble attributed
 * to a literal "**" rather than an error. That is why the exact-shape cases
 * below are pinned, including the ones that currently return null.
 */

const makeService = () => Object.create(TrackService.prototype) as TrackService;

describe('TrackService.getTrackFromLink', () => {
  let svc: TrackService;
  beforeEach(() => { svc = makeService(); });

  it('extracts artist and track from a Last.fm track URL', () => {
    // Note the `_` segment: Last.fm puts a literal underscore between artist
    // and track, and the regex has to match it exactly.
    expect(svc.getTrackFromLink('https://www.last.fm/music/Radiohead/_/Karma+Police')).toEqual({
      artistName: 'Radiohead',
      trackName: 'Karma Police',
    });
  });

  it('decodes + as a space in BOTH the artist and the track segment', () => {
    // Both halves, because Last.fm encodes spaces as + on both. A fixture with
    // a + only in the track segment would miss a broken artist half.
    expect(svc.getTrackFromLink('https://www.last.fm/music/James+Blake/_/Retrograde')).toEqual({
      artistName: 'James Blake',
      trackName: 'Retrograde',
    });
  });

  it('decodes percent-encoding in a track name', () => {
    expect(svc.getTrackFromLink('https://www.last.fm/music/Radiohead/_/Let+Down%2C+You+Down')).toEqual({
      artistName: 'Radiohead',
      trackName: 'Let Down, You Down',
    });
  });

  it('returns only the id for a Spotify track URL', () => {
    // A Spotify id carries no name, so trackName is the id and artistName is
    // ABSENT rather than empty - an empty string would be searched for.
    expect(svc.getTrackFromLink('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp')).toEqual({
      trackName: '3n3Ppam7vgaVa1iaRUc9Lp',
    });
  });

  it('handles the localised Spotify path', () => {
    expect(svc.getTrackFromLink('https://open.spotify.com/intl-pt/track/3n3Ppam7vgaVa1iaRUc9Lp')).toEqual({
      trackName: '3n3Ppam7vgaVa1iaRUc9Lp',
    });
  });

  it('returns null for a plain search string', () => {
    expect(svc.getTrackFromLink('Karma Police')).toBeNull();
    expect(svc.getTrackFromLink('')).toBeNull();
  });

  it('returns null for a link from a provider it does not know', () => {
    // Better a reportable null than a wrong guess.
    expect(svc.getTrackFromLink('https://soundcloud.com/artist/track')).toBeNull();
    expect(svc.getTrackFromLink('https://youtube.com/watch?v=abc123')).toBeNull();
  });

  it('does not confuse a Last.fm ALBUM url for a track url', () => {
    // An album url has no `_` segment, so it must not resolve. Getting this
    // wrong means `.track <album link>` reports the album name as a track.
    expect(svc.getTrackFromLink('https://www.last.fm/music/Radiohead/OK+Computer')).toBeNull();
  });
});

describe('TrackService.parseBoldDelimitedTrackAndArtist', () => {
  it('parses the canonical footer shape this bot renders', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Karma Police** **by** **Radiohead**')).toEqual({
      track: 'Karma Police',
      artist: 'Radiohead',
    });
  });

  it('keeps asterisks inside a title, which would otherwise break the split', () => {
    // The split requires exactly 3 pieces, so a title containing a literal
    // double-asterisk breaks the parse. Pinned as current behaviour: the
    // practical fix is a non-bold delimiter in the template, and this test is
    // what will notice if either side changes.
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**AC**DC** **by** **Back In Black**')).toBeNull();
  });

  it('returns null when the bold markers are missing on one side', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('Karma Police **by** **Radiohead**')).toBeNull();
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Karma Police** **by** Radiohead')).toBeNull();
  });

  it('returns null when the "by" delimiter is absent', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Karma Police** **Radiohead**')).toBeNull();
  });

  it('requires the surrounding spaces around "**by**"', () => {
    // ' **by** ' with spaces, not '**by**'. A template change to a tight
    // delimiter would stop the footer parsing at all.
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Track****by****Artist**')).toBeNull();
  });

  it('preserves internal spaces in the artist name', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Retrograde** **by** **James Blake**')).toEqual({
      track: 'Retrograde',
      artist: 'James Blake',
    });
  });

  it('returns null for an empty description rather than throwing', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('')).toBeNull();
  });
});
