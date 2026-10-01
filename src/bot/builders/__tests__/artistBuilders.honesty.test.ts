/**
 * `ArtistBuilders` — the artist overview / info / top-albums cards.
 *
 * The interesting surface is honesty, not structure. Three claims on these cards
 * are the ones that can go wrong without anything looking broken:
 *
 *  1. A zero is a measurement; an absence is not. The server stat line is
 *     emitted only when `serverPlays > 0` and the personal stat block only when
 *     `userPlays > 0` — a user who has never played the artist gets a card with
 *     no "N plays by you" line at all rather than "0 plays by you". The global
 *     Last.fm line is the deliberate exception: it is always present because the
 *     value came from a source that answered.
 *  2. The MusicBrainz block is entirely additive. A null `mbData`, a location
 *     with no country code, a birth date that is not today, a type with no gender
 *     — each must leave the card without that line and with nothing broken.
 *  3. `buildArtistTopAlbumsResponse` clamps its `page` before slicing, so a
 *     stale button cannot render an empty list under a page number that does not
 *     exist. "No albums found." is then only ever reachable when the artist
 *     genuinely has no albums on this page.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { ArtistBuilders } from '@bot/builders/artistBuilders';
import type { MusicBrainzArtistData } from '@bot/services/media/musicBrainzService';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  items?: Array<{ media?: { url?: string }; description?: string }>;
  accessory?: { media?: { url?: string } };
  emoji?: string | { id?: string; name?: string };
  custom_id?: string;
  label?: string;
  url?: string;
  disabled?: boolean;
}

const json = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[]; accent_color?: number };

/** Top-level text blocks. */
const texts = (response: ResponseModel): string[] =>
  json(response).components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content ?? '');

/**
 * The header block only — the first thing the card renders. It is a Section when
 * there is an image to hang on it and a plain text display when there is not, and
 * both shapes are pinned by the overview test above, so this reads whichever one
 * the builder chose. It deliberately does not join every text block on the card:
 * the stats block is a separate component and the header assertions are about
 * the header.
 */
const headerText = (response: ResponseModel): string => {
  const components = json(response).components;
  const header = components.find(c => c.type === ComponentType.Section) ?? components.find(c => c.type === ComponentType.TextDisplay);
  if (!header) return '';
  const inner = header.type === ComponentType.Section ? (header.components ?? []) : [header];
  return inner
    .filter(c => c.type === ComponentType.TextDisplay)
    .map(c => c.content ?? '')
    .join('\n');
};

const buttons = (response: ResponseModel): Cv2Component[] =>
  json(response).components
    .filter(c => c.type === ComponentType.ActionRow)
    .flatMap(c => c.components ?? []);

/** Every rendered block, wherever it lives. */
const body = (response: ResponseModel): string => texts(response).join('\n');

const emptyMb = (over: Partial<MusicBrainzArtistData> = {}): MusicBrainzArtistData => ({ links: {}, ...over });

const noServer = { serverPlays: 0, serverListeners: 0 };
const noUser = { userPlays: 0, lastMonthPlays: 0, userPercentage: 0 };
const globalStats = { globalPlays: 5_000_000, globalListeners: 800_000 };

describe('ArtistBuilders.buildArtistOverviewResponse', () => {
  interface OverviewOpts {
    totalArtistPlays?: number;
    monthPlays?: number;
    topTracks?: Array<{ name: string; playcount: number }>;
    topAlbums?: Array<{ name: string; playcount: number }>;
    genres?: string[];
    imageUrl?: string | null;
    accentColor?: number;
  }

  const overview = (over: OverviewOpts = {}) =>
    ArtistBuilders.buildArtistOverviewResponse(
      'Radiohead',
      1,
      'Tester',
      'target-1',
      'author-1',
      over.totalArtistPlays ?? 1500,
      over.monthPlays ?? 25,
      over.topTracks ?? [{ name: 'Creep', playcount: 40 }],
      over.topAlbums ?? [{ name: 'OK Computer', playcount: 120 }],
      over.genres ?? ['art rock', 'alternative'],
      over.imageUrl,
      over.accentColor,
    );

  it('singularises a total of one play', () => {
    const text = body(overview({ totalArtistPlays: 1, monthPlays: 0 }));
    expect(text).toContain('**1** play');
    expect(text).not.toContain('**1** plays');
  });

  it('omits the last-month clause when the month count is zero', () => {
    expect(body(overview({ monthPlays: 0 }))).not.toContain('last month');
    expect(body(overview({ monthPlays: 3 }))).toContain('— **3** last month');
  });

  it('drops the top-track and top-album sections when the user has none, rather than printing an empty list', () => {
    const text = body(overview({ topTracks: [], topAlbums: [] }));
    expect(text).not.toContain('**Your top tracks**');
    expect(text).not.toContain('**Your top albums**');
    // The totals are still there, because they were actually measured.
    expect(text).toContain('**1500** plays');
  });

  it('shows at most eight tracks and eight albums, and says nothing about the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Track ${i + 1}`, playcount: i + 1 }));
    const text = body(overview({ topTracks: many, topAlbums: many }));
    expect(text).toContain('`8`  **Track 8** - *8x*');
    expect(text).not.toContain('`9`  **Track 9**');
  });

  it('disables All tracks and All albums exactly when the list behind them is empty', () => {
    // A live button leading to an empty page is a promise the card cannot keep.
    const empty = buttons(overview({ topTracks: [], topAlbums: [] }));
    expect(empty.find(b => b.label === 'All tracks')?.disabled).toBe(true);
    expect(empty.find(b => b.label === 'All albums')?.disabled).toBe(true);

    const full = buttons(overview());
    expect(full.find(b => b.label === 'All tracks')?.disabled).toBe(false);
    expect(full.find(b => b.label === 'All albums')?.disabled).toBe(false);
  });

  it('carries both user ids into every nav custom id', () => {
    expect(buttons(overview()).map(b => b.custom_id)).toEqual([
      'artist-info:1:target-1:author-1',
      'artist-tracks:1:target-1:author-1:',
      'artist-albums:1:target-1:author-1:',
    ]);
  });

  it('uses a section with a thumbnail when there is an image, and a plain text block when there is not', () => {
    const withImage = overview({ imageUrl: 'https://img/artist.jpg' });
    const without = overview({ imageUrl: undefined });
    expect(json(withImage).components.some(c => c.type === ComponentType.Section)).toBe(true);
    expect(JSON.stringify(json(withImage))).toContain('https://img/artist.jpg');
    expect(json(without).components.some(c => c.type === ComponentType.Section)).toBe(false);
  });

  it('produces a valid container for an artist with no tracks, albums or genres at all', () => {
    const response = overview({ topTracks: [], topAlbums: [], genres: [], totalArtistPlays: 0, monthPlays: 0 });
    expect(response.isComponentsV2).toBe(true);
    expect(json(response).components.length).toBeGreaterThan(0);
    expect(body(response)).toContain('**0** plays');
  });
});

describe('ArtistBuilders.buildArtistInfoResponse', () => {
  const info = (
    mb: MusicBrainzArtistData | null,
    bio: string,
    server = noServer,
    user = noUser,
    genres: string[] = [],
    imageUrl?: string | null,
  ) =>
    ArtistBuilders.buildArtistInfoResponse(
      'Radiohead',
      1,
      'Tester',
      'target-1',
      'author-1',
      mb,
      bio,
      server,
      globalStats,
      user,
      genres,
      imageUrl,
    );

  it('omits the whole MusicBrainz block when there is no MusicBrainz data at all', () => {
    expect(headerText(info(null, ''))).toBe('## [Radiohead](https://www.last.fm/music/Radiohead)');
  });

  it('adds a country flag only for a real two-letter code', () => {
    const flag = String.fromCodePoint(127397 + 71, 127397 + 66); // GB
    const gb = headerText(info(emptyMb({ location: 'Abington', countryCode: 'gb' }), ''));
    const noCode = headerText(info(emptyMb({ location: 'Abington' }), ''));
    const tooLong = headerText(info(emptyMb({ location: 'Abington', countryCode: 'GBR' }), ''));

    expect(gb).toContain(`Artist from **Abington** ${flag}`);
    // No trailing double space when there is no flag to put there.
    expect(noCode.endsWith('Artist from **Abington**')).toBe(true);
    expect(noCode).not.toContain('Abington**  ');
    // A three-letter code is not a country code, so it is treated as absent
    // rather than rendered as three nonsense regional indicators.
    expect(tooLong).toBe(noCode);
  });

  it('renders the birth date as a timestamp and badges it only on the actual birthday', () => {
    const now = new Date();
    const today = Math.floor(Date.UTC(1968, now.getUTCMonth(), now.getUTCDate()) / 1000);
    const notToday = Math.floor(Date.UTC(1968, 0, 1) / 1000);

    expect(headerText(info(emptyMb({ birthDate: today }), ''))).toContain('🎂 **(Birthday today!)**');
    expect(headerText(info(emptyMb({ birthDate: notToday }), ''))).toContain(`Born: <t:${notToday}:D>`);
    expect(headerText(info(emptyMb({ birthDate: notToday }), ''))).not.toContain('Birthday today');
  });

  it('joins type and gender when both exist, and renders each alone when only one does', () => {
    expect(headerText(info(emptyMb({ type: 'Group', gender: 'Male' }), ''))).toContain('-# Group - Male');
    expect(headerText(info(emptyMb({ type: 'Group' }), ''))).toContain('-# Group');
    expect(headerText(info(emptyMb({ gender: 'Female' }), ''))).toContain('-# Female');
    expect(headerText(info(emptyMb(), ''))).not.toContain('-#');
  });

  it('strips markup and the "Read more" tail out of the bio', () => {
    const dirty = '<p>Radiohead are an English rock band.</p>\n<a href="x">Read more on Last.fm</a>';
    const text = body(info(null, dirty));
    expect(text).toContain('Radiohead are an English rock band.');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('Read more on Last.fm');
  });

  it('omits the bio block entirely for an empty or whitespace-only bio', () => {
    expect(texts(info(null, ''))).toHaveLength(2);
    expect(texts(info(null, '   \n  '))).toHaveLength(2);
  });

  it('keeps the global Last.fm line when the server has nobody, and drops the server line', () => {
    const text = body(info(null, '', { serverPlays: 0, serverListeners: 0 }));
    expect(text).not.toContain('plays in this server');
    expect(text).toContain('**5,000,000** Last.fm plays by **800,000** listeners');
  });

  it('renders the server line, with its listener count, only when there are server plays', () => {
    const one = body(info(null, '', { serverPlays: 1, serverListeners: 1 }));
    const many = body(info(null, '', { serverPlays: 30, serverListeners: 4 }));
    expect(one).toContain('**1** plays in this server by **1** listener\n');
    expect(many).toContain('**30** plays in this server by **4** listeners');
  });

  it('omits the whole personal block for a user who has never played the artist', () => {
    // The load-bearing honest omission: no "0 plays by Tester" and no
    // "0.00 % of all your plays".
    const text = body(info(null, '', noServer, { userPlays: 0, lastMonthPlays: 0, userPercentage: 0 }));
    expect(text).not.toContain('plays by **Tester**');
    expect(text).not.toContain('of all your plays');
  });

  it('omits the percentage clause when the share is a real zero', () => {
    const text = body(info(null, '', noServer, { userPlays: 4, lastMonthPlays: 0, userPercentage: 0 }));
    expect(text).toContain('**4** plays by **Tester**');
    expect(text).not.toContain('of all your plays');
  });

  it('renders the percentage to two decimals and the month clause when both are real', () => {
    const text = body(info(null, '', noServer, { userPlays: 4, lastMonthPlays: 2, userPercentage: 1.5 }));
    expect(text).toContain('**4** plays by **Tester** — **2** last month');
    expect(text).toContain('**1.50 %** of all your plays');
  });

  it('renders the genres line only when there are genres', () => {
    expect(body(info(null, '', noServer, noUser, ['art rock', 'trip hop']))).toContain('-# art rock - trip hop');
    expect(body(info(null, '', noServer, noUser, []))).not.toContain('-#');
  });

  it('adds a social row only for the services the artist actually has', () => {
    const none = buttons(info(emptyMb(), ''));
    const spotifyOnly = buttons(info(emptyMb({ links: { spotify: 'https://open.spotify.com/artist/1' } }), ''));
    expect(none.filter(b => b.url)).toEqual([]);
    expect(spotifyOnly.filter(b => b.url).map(b => b.url)).toEqual(['https://open.spotify.com/artist/1']);
  });

  it('never puts more than five buttons in the social row, even with every link present', () => {
    const everyLink = info(
      emptyMb({
        links: {
          spotify: 'https://open.spotify.com/artist/1',
          appleMusic: 'https://music.apple.com/artist/1',
          instagram: 'https://instagram.com/artist',
          twitter: 'https://twitter.com/artist',
          bandcamp: 'https://bandcamp.com/artist',
          deezer: 'https://deezer.com/artist/1',
          youtube: 'https://youtube.com/@artist',
          lastfm: 'https://last.fm/music/Radiohead',
        },
      }),
      '',
    );
    // Three nav buttons first, then at most five links. Discord rejects a sixth.
    const linkButtons = buttons(everyLink).filter(b => b.url);
    expect(linkButtons).toHaveLength(5);
  });

  it('drops the lowest-priority links when the row is already full', () => {
    const packed = info(
      emptyMb({
        links: {
          spotify: 'https://open.spotify.com/artist/1',
          appleMusic: 'https://music.apple.com/artist/1',
          instagram: 'https://instagram.com/artist',
          twitter: 'https://twitter.com/artist',
          bandcamp: 'https://bandcamp.com/artist',
        },
      }),
      '',
    );
    expect(buttons(packed).filter(b => b.url).map(b => b.url)).toEqual([
      'https://open.spotify.com/artist/1',
      'https://music.apple.com/artist/1',
      'https://instagram.com/artist',
      'https://twitter.com/artist',
      'https://bandcamp.com/artist',
    ]);
  });

  it('puts the social row after the nav row, so the navigation is never pushed off the card', () => {
    const response = info(emptyMb({ links: { spotify: 'https://open.spotify.com/artist/1' } }), '');
    const rows = json(response).components.filter(c => c.type === ComponentType.ActionRow);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.components?.some(b => b.label === 'Overview')).toBe(true);
    expect(rows[1]?.components?.some(b => b.url)).toBe(true);
  });

  it('produces a valid container for an artist with no MusicBrainz data, no bio and no plays', () => {
    const response = info(null, '', noServer, noUser, []);
    expect(response.isComponentsV2).toBe(true);
    expect(json(response).components.length).toBeGreaterThan(0);
    expect(body(response)).toContain('**5,000,000** Last.fm plays by **800,000** listeners');
  });
});

describe('ArtistBuilders.buildArtistTopAlbumsResponse', () => {
  const albums = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `Album ${i + 1}`, playcount: i + 1 }));

  const page = (list: Array<{ name: string; playcount: number }>, index: number, totalArtistPlays = 1500) =>
    ArtistBuilders.buildArtistTopAlbumsResponse(
      'Radiohead',
      1,
      'Tester',
      'target-1',
      'author-1',
      list,
      totalArtistPlays,
      list.length,
      index,
    );

  it('claims one page of one for an artist with no albums, and says so in words', () => {
    const text = body(page([], 0));
    expect(text).toContain('Page 1/1 — 0 different albums');
    expect(text).toContain('No albums found.');
  });

  it('keeps ranking continuous across pages', () => {
    // `page` is a raw zero-based index here (unlike the album tracks card), so
    // index 1 is the middle page of three: albums 11-20. Every title is a link
    // back to its Last.fm page, so the expected strings are too.
    const text = body(page(albums(25), 1));
    expect(text).toContain('Page 2/3 — 25 different albums');
    expect(text).toContain('11. **[Album 11](https://www.last.fm/music/Radiohead/Album+11)**');
    expect(text).toContain('20. **[Album 20](https://www.last.fm/music/Radiohead/Album+20)**');
    expect(text).not.toContain('1. **[Album 1](');
  });

  it('links every album back to its Last.fm page and singularises a single play', () => {
    const text = body(page([{ name: 'Kid A', playcount: 1 }], 0));
    expect(text).toContain('1. **[Kid A](https://www.last.fm/music/Radiohead/Kid+A)** - *1 play*');
  });

  it('singularises one total artist play in the footer', () => {
    expect(body(page(albums(1), 0, 1))).toContain('Tester has 1 total artist play\n');
  });

  it('disables both directions on a single-page artist', () => {
    const single = buttons(page(albums(3), 0));
    expect(single.find(b => b.custom_id === 'aab:first:0:1:target-1:author-1')?.disabled).toBe(true);
    expect(single.find(b => b.custom_id === 'aab:next:0:1:target-1:author-1')?.disabled).toBe(true);
  });

  it('disables ◀️ on page 0 and leaves ▶️ live', () => {
    const first = buttons(page(albums(25), 0));
    expect(first.find(b => b.custom_id === 'aab:prev:0:1:target-1:author-1')?.disabled).toBe(true);
    expect(first.find(b => b.custom_id === 'aab:next:0:1:target-1:author-1')?.disabled).toBe(false);
  });

  it('disables ▶️ on the last page and leaves ◀️ live', () => {
    const last = buttons(page(albums(25), 2));
    expect(last.find(b => b.custom_id === 'aab:next:2:1:target-1:author-1')?.disabled).toBe(true);
    expect(last.find(b => b.custom_id === 'aab:prev:2:1:target-1:author-1')?.disabled).toBe(false);
  });

  it('always offers a way back to the overview, whatever the page', () => {
    expect(buttons(page(albums(25), 1)).some(b => b.custom_id === 'artist-overview:1:target-1:author-1')).toBe(true);
  });

  /**
   * The paginator CLAMPS. `totalPages` is computed and `page` is pinned into
   * `[0, totalPages - 1]` before the slice is taken, so an out-of-range index
   * renders the last (or first) real page instead of printing a page number that
   * does not exist together with an empty list. An empty list under "Page
   * 100/3" read as "this artist has no albums", which is a claim about the
   * artist, not about the button that was pressed.
   */
  describe('a page past the end', () => {
    it('clamps onto the last real page and lists that page’s albums', () => {
      const text = body(page(albums(25), 99));
      expect(text).toContain('Page 3/3 — 25 different albums');
      expect(text).toContain('21. **[Album 21](https://www.last.fm/music/Radiohead/Album+21)**');
      expect(text).toContain('25. **[Album 25](https://www.last.fm/music/Radiohead/Album+25)**');
      expect(text).not.toContain('No albums found.');
    });

    it('never prints a page number that does not exist', () => {
      const text = body(page(albums(25), 99));
      expect(text).not.toContain('Page 100/3');
      expect(text).toBe(body(page(albums(25), 2)));
    });

    it('clamps a negative index back onto page 1 rather than printing a zero page number', () => {
      const text = body(page(albums(25), -1));
      expect(text).toContain('Page 1/3 — 25 different albums');
      expect(text).not.toContain('Page 0/3');
      expect(text).toBe(body(page(albums(25), 0)));
    });

    it('disables forward navigation on the clamped page, because there is nowhere past the end', () => {
      const over = buttons(page(albums(25), 99));
      expect(over.find(b => b.custom_id === 'aab:next:2:1:target-1:author-1')?.disabled).toBe(true);
      expect(over.find(b => b.custom_id === 'aab:last:2:1:target-1:author-1')?.disabled).toBe(true);
    });

    it('still leaves the way back live, so the user is not stranded', () => {
      const over = buttons(page(albums(25), 99));
      expect(over.find(b => b.custom_id === 'aab:first:2:1:target-1:author-1')?.disabled).toBe(false);
      expect(over.find(b => b.custom_id === 'aab:prev:2:1:target-1:author-1')?.disabled).toBe(false);
      expect(over.some(b => b.custom_id === 'artist-overview:1:target-1:author-1')).toBe(true);
    });

    it('encodes the clamped page in the custom ids, not the requested one', () => {
      const ids = buttons(page(albums(25), 99)).map(b => b.custom_id);
      expect(ids).toContain('aab:next:2:1:target-1:author-1');
      expect(ids.every(id => !id?.includes(':99:'))).toBe(true);
    });
  });
});
