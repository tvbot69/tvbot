import { describe, it, expect } from 'vitest';
import { AlbumBuilders } from '@bot/builders/albumBuilders';
import { ArtistBuilders } from '@bot/builders/artistBuilders';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { TrackBuilders } from '@bot/builders/trackBuilders';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The artist / album / track cards printed their totals with an unconditional
 * plural, so a single-entry case read "1 total albums", "1 different tracks" and
 * "1 listeners". These are claims about a count, so the noun has to agree with
 * the count — and every case is pinned in BOTH directions, because an assertion
 * that only checks the singular would also pass on a builder that always printed
 * the singular.
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const targetUser = { discordUserId: '1', userNameLastFm: 'alice' } as User;

describe('AlbumBuilders: the noun agrees with the count', () => {
  const album = (over: Record<string, unknown> = {}) =>
    ({
      albumId: '1',
      albumName: 'Selected Ambient Works',
      artistName: 'Aphex Twin',
      tracks: [{ name: 'Xtal', playcount: 7 }],
      ...over,
    }) as never;

  it('says "1 total track" for a single-track album', () => {
    const text = body(AlbumBuilders.buildAlbumTracksResponse(album(), targetUser, 'req'));
    expect(text).toContain('1 total track');
    expect(text).not.toContain('1 total tracks');
  });

  it('still says "total tracks" for two', () => {
    const text = body(
      AlbumBuilders.buildAlbumTracksResponse(
        album({ tracks: [{ name: 'Xtal', playcount: 7 }, { name: 'Tha', playcount: 9 }] }),
        targetUser,
        'req',
      ),
    );
    expect(text).toContain('2 total tracks');
  });

  it('says "1 listener" for a release one person has played', () => {
    const text = body(
      AlbumBuilders.buildAlbumInfoResponse(
        album({ globalPlaycount: 10, globalListeners: 1 }),
        targetUser,
        'req',
      ),
    );
    expect(text).toContain('**1** listener');
    expect(text).not.toContain('**1** listeners');
  });

  it('still says "listeners" for two', () => {
    const text = body(
      AlbumBuilders.buildAlbumInfoResponse(
        album({ globalPlaycount: 10, globalListeners: 2 }),
        targetUser,
        'req',
      ),
    );
    expect(text).toContain('**2** listeners');
  });
});

describe('ArtistBuilders: the noun agrees with the count', () => {
  it('says "1 listener" when the artist has one global listener', () => {
    const text = body(
      ArtistBuilders.buildArtistInfoResponse(
        'Aphex Twin',
        '1',
        'alice',
        '1',
        '1',
        null,
        '',
        { serverPlays: 0, serverListeners: 0 },
        { globalPlays: 10, globalListeners: 1 },
        { userPlays: 5, lastMonthPlays: 0, userPercentage: 1 },
        [],
      ),
    );
    expect(text).toContain('**1** listener');
    expect(text).not.toContain('**1** listeners');
  });

  it('still says "listeners" for two', () => {
    const text = body(
      ArtistBuilders.buildArtistInfoResponse(
        'Aphex Twin',
        '1',
        'alice',
        '1',
        '1',
        null,
        '',
        { serverPlays: 0, serverListeners: 0 },
        { globalPlays: 10, globalListeners: 2 },
        { userPlays: 5, lastMonthPlays: 0, userPercentage: 1 },
        [],
      ),
    );
    expect(text).toContain('**2** listeners');
  });

  it('says "1 different album" on the top-albums card', () => {
    const text = body(
      ArtistBuilders.buildArtistTopAlbumsResponse(
        'Aphex Twin',
        '1',
        'alice',
        '1',
        '1',
        [{ name: 'SAW', playcount: 20 }],
        20,
        1,
      ),
    );
    expect(text).toContain('1 different album');
    expect(text).not.toContain('1 different albums');
  });

  it('still says "different albums" for two', () => {
    const text = body(
      ArtistBuilders.buildArtistTopAlbumsResponse(
        'Aphex Twin',
        '1',
        'alice',
        '1',
        '1',
        [
          { name: 'SAW', playcount: 20 },
          { name: 'Analord', playcount: 4 },
        ],
        24,
        2,
      ),
    );
    expect(text).toContain('2 different albums');
  });
});

describe('ArtistTrackBuilders: the noun agrees with the count', () => {
  it('says "1 different track" for one distinct track', () => {
    const text = body(
      ArtistTrackBuilders.buildArtistTopTracksResponse(
        'Aphex Twin',
        'alice',
        [{ name: 'Xtal', playcount: 30 }],
        30,
        1,
      ),
    );
    expect(text).toContain('1 different track');
    expect(text).not.toContain('1 different tracks');
  });

  it('still says "different tracks" for two', () => {
    const text = body(
      ArtistTrackBuilders.buildArtistTopTracksResponse(
        'Aphex Twin',
        'alice',
        [
          { name: 'Xtal', playcount: 30 },
          { name: 'Tha', playcount: 9 },
        ],
        39,
        2,
      ),
    );
    expect(text).toContain('2 different tracks');
  });
});

describe('TrackBuilders: the noun agrees with the count', () => {
  const track = (over: Record<string, unknown> = {}) =>
    ({
      trackId: '1',
      trackName: 'Xtal',
      artistName: 'Aphex Twin',
      ...over,
    }) as never;

  it('says "1 listener" when one person has played the track', () => {
    const text = body(
      TrackBuilders.buildTrackInfoResponse(
        track({ globalPlaycount: 10, globalListeners: 1 }),
        targetUser,
        'alice',
      ),
    );
    expect(text).toContain('**1** listener');
    expect(text).not.toContain('**1** listeners');
  });

  it('still says "listeners" for two', () => {
    const text = body(
      TrackBuilders.buildTrackInfoResponse(
        track({ globalPlaycount: 10, globalListeners: 2 }),
        targetUser,
        'alice',
      ),
    );
    expect(text).toContain('**2** listeners');
  });
});