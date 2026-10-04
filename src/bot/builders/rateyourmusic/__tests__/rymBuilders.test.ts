import { describe, expect, it } from 'vitest';
import { RymBuilders, starsFor } from '@bot/builders/rateyourmusic/rymBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('starsFor', () => {
  it('renders only filled stars, no trailing dots', () => {
    expect(starsFor(4)).toBe('<:fullstar:1556308224917905498><:fullstar:1556308224917905498><:fullstar:1556308224917905498><:fullstar:1556308224917905498>');
    expect(starsFor(3.1)).toContain('<:quarterstar:1556326514696392925>');
    expect(starsFor(3.1)).not.toContain('·');
  });

  it('renders half and quarter for fractions', () => {
    expect(starsFor(3.5)).toContain('<:halfstar:1556326419439550474>');
    expect(starsFor(1.3)).toContain('<:quarterstar:1556326514696392925>');
  });

  it('null rating renders nothing', () => {
    expect(starsFor(null)).toBe('');
  });
});

describe('RymBuilders.buildSongResponse', () => {
  it('embeds a card with stars and a thumbnail section when a cover exists', () => {
    const res = RymBuilders.buildSongResponse(
      {
        slug: 'pixies/bone-machine',
        title: 'Bone Machine',
        artist: 'Pixies',
        url: 'https://rateyourmusic.com/song/pixies/bone-machine/',
        released: 'September 1989',
        year: 1989,
        rating: 3.9,
        nRatings: 11,
        appearsOn: [{ title: 'Doolittle', url: 'https://rateyourmusic.com/release/album/pixies/doolittle/', coverUrl: '', releaseType: 'album' }],
      },
      0x112233,
      'https://img/cover.jpg',
    );
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    expect(res.isComponentsV2).toBe(true);
  });
});

describe('RymBuilders.buildArtistResponse', () => {
  it('chunks the header subline at three items per line', () => {
    const res = RymBuilders.buildArtistResponse(
      {
        rymId: 'radiohead',
        name: 'Radiohead',
        url: 'https://rateyourmusic.com/artist/radiohead/',
        formed: '1985',
        located: 'Oxford, England',
        members: [],
        aliases: [],
        genres: ['Alternative Rock', 'Art Rock', 'Electronic', 'Art Pop'],
        related: [],
        notes: '',
        discography: [],
      },
      0x112233,
      null,
    );
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    const json = JSON.stringify(res.componentsV2Container?.toJSON());
    const sublines = json.match(/-# [^\\"]*/g) ?? [];
    // first two sublines are the header chunks: 3 items, then 3
    const counts = sublines.slice(0, 2).map((l) => l.split(' • ').length);
    expect(counts).toEqual([3, 3]);
  });
});
