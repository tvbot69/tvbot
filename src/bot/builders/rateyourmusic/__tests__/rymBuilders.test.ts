import { describe, expect, it } from 'vitest';
import { RymBuilders, starsFor } from '@bot/builders/rateyourmusic/rymBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('starsFor', () => {
  it('renders full stars for whole numbers', () => {
    expect(starsFor(4)).toBe('<:fullstar:1556308224917905498><:fullstar:1556308224917905498><:fullstar:1556308224917905498><:fullstar:1556308224917905498>·');
  });

  it('renders half and quarter for fractions', () => {
    expect(starsFor(3.5)).toContain('<:halfstar:1556326419439550474>');
    expect(starsFor(1.3)).toContain('<:quarterstar:1556326514696392925>');
  });

  it('null rating renders a dashed row', () => {
    expect(starsFor(null)).toBe('· · · · ·');
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
