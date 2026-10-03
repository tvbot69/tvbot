import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArtistPage, parseChartPage, parseReleasePage } from '../rymParsers';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parseChartPage', () => {
  const items = parseChartPage(fixture('charts_all_time.html'));

  it('parses every chart row', () => {
    expect(items.length).toBe(40);
  });

  it('maps the top entry faithfully', () => {
    const top = items[0];
    expect(top).toMatchObject({
      rymId: 'kendrick-lamar/to-pimp-a-butterfly',
      title: 'To Pimp a Butterfly',
      artist: 'Kendrick Lamar',
      artistId: 'kendrick-lamar',
      releaseType: 'album',
      year: 2015,
      rating: 4.37,
      position: 1,
    });
    expect(top?.primaryGenres).toContain('Conscious Hip Hop');
    expect(top?.secondaryGenres).toContain('Political Hip Hop');
    expect(top?.coverUrl).toMatch(/^https:\/\//);
  });

  it('returns an empty list for markup without chart items', () => {
    expect(parseChartPage('<html><body></body></html>')).toEqual([]);
  });
});

describe('parseArtistPage', () => {
  const artist = parseArtistPage(fixture('artist_radiohead.html'), 'radiohead');

  it('reads the identity block', () => {
    expect(artist.name).toBe('Radiohead');
    expect(artist.rymId).toBe('radiohead');
  });

  it('reads the info table', () => {
    expect(artist.members.length).toBe(5);
    expect(artist.genres).toContain('Alternative Rock');
    expect(artist.formed.length).toBeGreaterThan(0);
  });

  it('reads the discography', () => {
    expect(artist.discography.length).toBe(80);
    const first = artist.discography[0];
    expect(first).toMatchObject({
      rymId: 'radiohead/pablo-honey',
      title: 'Pablo Honey',
      artistId: 'radiohead',
      year: 1993,
      releaseType: 'album',
    });
  });

  it('returns defaults on unexpected markup', () => {
    const empty = parseArtistPage('<html><body><h1>X</h1></body></html>', 'x');
    expect(empty.name).toBe('X');
    expect(empty.discography).toEqual([]);
    expect(empty.members).toEqual([]);
  });
});

describe('parseReleasePage', () => {
  const release = parseReleasePage(fixture('release_surfer_rosa_wayback.html'), 'pixies/surfer-rosa');

  it('reads identity, year, rating and counts', () => {
    expect(release).toMatchObject({
      title: 'Surfer Rosa',
      artist: 'Pixies',
      year: 1988,
      rating: 3.92,
      nRatings: 29150,
      releaseType: 'album',
    });
  });

  it('reads genres and descriptors', () => {
    expect(release.primaryGenres).toContain('Indie Rock');
    expect(release.descriptors.length).toBe(17);
    expect(release.date).toBe('21 March 1988');
  });

  it('reads the tracklist without the mobile duplicate', () => {
    expect(release.tracklist.length).toBe(13);
    expect(release.tracklist[0]).toMatchObject({ position: 'A1', title: 'Bone Machine' });
  });

  it('returns empty fields on a 503 origin-block page', () => {
    const blocked = parseReleasePage(fixture('release_surfer_rosa.html'), 'pixies/surfer-rosa');
    expect(blocked.title).toBe('');
    expect(blocked.artist).toBe('');
    expect(blocked.tracklist).toEqual([]);
  });
});
