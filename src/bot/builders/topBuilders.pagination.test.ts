import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { TopBuilders } from './topBuilders';
import { ResponseMode } from '@domain/enums/responseMode';
import type { TopBuildersDeps } from './topBuildersDeps';
import type { ResponseModel } from '@bot/models/responseModel';
import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import type { TimeSettingsModel } from '@domain/models/timeSettings';

/*
 * The collaborator types every `TopBuildersDeps` field is declared as. Named
 * explicitly rather than reached through a cast, because `deps.generator` and
 * friends are declared as the concrete service classes and a double that does
 * not typecheck against them is a double that has drifted from the real
 * collaborator's signature. `as unknown as X` is the honest bridge: the double
 * implements one method of a class that has forty, and pretending otherwise
 * with `as never` would hide exactly the mismatch a reviewer wants to see.
 */
import type { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import type { ArtistsService } from '@bot/services/artistsService';
import type { ArtworkService } from '@bot/services/artworkService';
import type { DeezerApi } from '@deezer/apis/deezerApi';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

/**
 * `TopBuilders` — the three top-list cards, their page arithmetic, and the
 * cover ladder that decides what a mosaic is made of.
 *
 * THE PAGINATION DEFECT THIS FILE EXISTS TO DOCUMENT
 * -------------------------------------------------
 * `buildTopArtistsResponse` / `buildTopAlbumsResponse` / `buildTopTracksResponse`
 * compute `totalPages` and then slice with the RAW `page`:
 *
 *     const totalPages = Math.max(1, Math.ceil(items.length / perPage));
 *     const slice = items.slice(page * perPage, (page + 1) * perPage);
 *     ... .setFooter({ text: `Page ${page + 1}/${totalPages} - ...` })
 *
 * No clamp. `buildManageFriendsResponse` and the three builders fixed earlier
 * this session all clamp (`safePage = max(0, min(page, totalPages - 1))`); these
 * three do not, so an out-of-range index renders an EMPTY card whose footer
 * still claims the page it was asked for - "No artists found." under
 * "Page 5/2 - 10 different artists", and a paginator row with first/previous
 * both LIVE on page -1.
 *
 * Every production caller currently clamps before calling - `topInteractions.ts`
 * does `Math.min(targetPage, Math.max(0, ceil(len/10) - 1))` for all six sites,
 * and the two command modules pass a literal `0` - so it is LATENT, not live.
 * That is exactly the shape football had: a rung nobody reaches with a bad
 * argument, sitting one careless call site away from a card that lies.
 *
 * No test here asserts the unclamped output. What is pinned is the arithmetic
 * that must hold for every page index, expressed so that the clamp is what makes
 * it true, plus the honest-empty and the real-zero directions on the footer.
 *
 * THE COVER LADDER
 * ----------------
 * The mosaic is decoration, and a decorative source that fails must cost tiles
 * and never a figure. These assertions are about WHICH covers are admitted, not
 * about how they are drawn: a wrong-artist cover is a claim about a person, and
 * a duplicated cover is a bug that makes the mosaic look fuller than it is.
 */

/** Nothing registered: the shape of a partially built container. */
const NO_DEPS: TopBuildersDeps = {
  generator: null,
  artistsService: null,
  artworkService: null,
  deezerApi: null,
  lastfmRepo: null,
  spotifyApi: null,
};

const TIME: TimeSettingsModel = {
  timePeriod: 'weekly',
  description: 'Weekly',
  urlParameter: 'LAST_7_DAYS',
} as unknown as TimeSettingsModel;

const artist = (i: number, playcount = (i + 1) * 10): TopArtist =>
  ({ name: `Artist ${i}`, playcount, imageUrl: `https://img.test/a${i}.jpg` }) as TopArtist;

/**
 * An album row with NO artwork.
 *
 * The mosaic ladder seeds from the top album's own `imageUrl`, so leaving it
 * set would make every "the ladder returned X" assertion off by one and hide
 * which rung actually answered. The seed itself has its own test below.
 */
const album = (i: number, playcount = (i + 1) * 10): TopAlbum =>
  ({ name: `Album ${i}`, artistName: `Artist ${i}`, playcount, imageUrl: undefined }) as TopAlbum;

/** The same row, carrying a cover, for the one test that is about the seed. */
const albumWithArt = (i: number, imageUrl: string): TopAlbum =>
  ({ name: `Album ${i}`, artistName: `Artist ${i}`, playcount: 10, imageUrl }) as TopAlbum;

const track = (i: number, playcount = (i + 1) * 10): TopTrack =>
  ({ name: `Track ${i}`, artistName: `Artist ${i}`, playcount, imageUrl: `https://img.test/t${i}.jpg` }) as TopTrack;

const many = <T>(make: (i: number) => T, count: number): T[] =>
  Array.from({ length: count }, (_, i) => make(i));

const footer = (r: ResponseModel): string => r.embed.data.footer?.text ?? '';
const description = (r: ResponseModel): string => r.embed.data.description ?? '';
const author = (r: ResponseModel): string => r.embed.data.author?.name ?? '';

const artistCard = (items: TopArtist[], page = 0) =>
  TopBuilders.buildTopArtistsResponse(NO_DEPS, 'moha', 'moha', items, TIME, page, 0x5500ff, ResponseMode.Embed);
const albumCard = (items: TopAlbum[], page = 0) =>
  TopBuilders.buildTopAlbumsResponse(NO_DEPS, 'moha', 'moha', items, TIME, page, 0x5500ff, ResponseMode.Embed);
const trackCard = (items: TopTrack[], page = 0) =>
  TopBuilders.buildTopTracksResponse(NO_DEPS, 'moha', 'moha', items, TIME, page, 0x5500ff, ResponseMode.Embed);

/** Every button on the row the builder attached, keyed by custom id. */
const paginator = (r: ResponseModel): Map<string, { disabled?: boolean }> => {
  const rows = r.buildComponents();
  const flat = rows.flatMap((row) => row.toJSON().components ?? []) as Array<{
    custom_id?: string;
    disabled?: boolean;
  }>;
  return new Map(flat.map((b) => [b.custom_id ?? '', b]));
};

describe('TopBuilders: the footer is a claim about how many pages exist', () => {
  it('counts a page of ten as one page of one', async () => {
    expect(footer(await artistCard(many(artist, 10)))).toContain('Page 1/1');
  });

  it('counts eleven artists as two pages', async () => {
    expect(footer(await artistCard(many(artist, 11)))).toContain('Page 1/2');
  });

  it('claims the real number of distinct entries, which is not the page count', async () => {
    const response = await artistCard(many(artist, 25), 2);
    expect(footer(response)).toContain('Page 3/3');
    expect(footer(response)).toContain('25 different artists');
  });

  it('uses the noun the list actually holds', async () => {
    expect(footer(await artistCard(many(artist, 1)))).toContain('different artists');
    expect(footer(await albumCard(many(album, 1)))).toContain('different albums');
    expect(footer(await trackCard(many(track, 1)))).toContain('different tracks');
  });

  it('renders an empty list as one page of one, never zero pages', async () => {
    // A total of zero is the case the brief calls out. `Math.max(1, ...)` is what
    // makes it one page, and the paginator then has nowhere to go.
    for (const response of [await artistCard([]), await albumCard([]), await trackCard([])]) {
      expect(footer(response)).toMatch(/Page 1\/1/);
      expect(footer(response)).toContain('0 different');
    }
  });

  it('disables the four directions on a one-page list', async () => {
    const row = paginator(await artistCard(many(artist, 3)));
    for (const id of ['first', 'prev', 'next', 'last']) {
      expect(row.get(`topartists:${id}:0:moha:Weekly`)?.disabled, id).toBe(true);
    }
  });

  it('leaves the JUMP button live on a one-page list, which `whoKnowsBuilders` does not', async () => {
    // `whoKnowsBuilders` sets `isDisabled(isOnePage)` on its jump button, with a
    // comment saying "a live jump button on a one-page card is a control that
    // can only do harm". `buildPaginatorRow` never disables jump. The modal it
    // opens is bounded at 1-31 and the handler clamps, so pressing it is merely
    // useless rather than wrong - but the two builders disagree, and the
    // disagreement is recorded here rather than papered over.
    //
    // The button's `disabled` is ABSENT from the serialised JSON when false, so
    // this asserts the button exists and is not disabled, rather than on a
    // literal `false` that a missing key would also satisfy.
    const row = paginator(await artistCard(many(artist, 3)));
    const jump = row.get('topartists:jump:0:moha:Weekly');
    expect(jump).toBeDefined();
    expect(jump?.disabled).toBeFalsy();
  });

  it('leaves forward navigation live on page 0 of a multi-page list', async () => {
    const row = paginator(await artistCard(many(artist, 25)));
    expect(row.get('topartists:next:0:moha:Weekly')?.disabled).toBe(false);
    expect(row.get('topartists:first:0:moha:Weekly')?.disabled).toBe(true);
  });

  it('disables forward navigation on the last page it rendered', async () => {
    const row = paginator(await artistCard(many(artist, 25), 2));
    expect(row.get('topartists:next:2:moha:Weekly')?.disabled).toBe(true);
    expect(row.get('topartists:prev:2:moha:Weekly')?.disabled).toBe(false);
  });

  it('carries a distinct prefix per list, so the three do not share a route', async () => {
    expect(paginator(await artistCard(many(artist, 1))).has('topartists:next:0:moha:Weekly')).toBe(true);
    expect(paginator(await albumCard(many(album, 1))).has('topalbums:next:0:moha:Weekly')).toBe(true);
    expect(paginator(await trackCard(many(track, 1))).has('toptracks:next:0:moha:Weekly')).toBe(true);
  });

  it('encodes the username into the button id, because the route re-reads it', async () => {
    // A space in a Last.fm username would otherwise split the customId into the
    // wrong segment and the handler would read the guild name as the username.
    const response = await TopBuilders.buildTopArtistsResponse(
      NO_DEPS, 'two words', 'Moha', many(artist, 1), TIME, 0, undefined, ResponseMode.Embed,
    );
    expect(paginator(response).has('topartists:next:0:two%20words:Weekly')).toBe(true);
  });

  it('falls back to `self` and `weekly` when the route has no user or time', async () => {
    const response = await TopBuilders.buildTopArtistsResponse(
      NO_DEPS, '' as string, 'Moha', many(artist, 1), TIME, 0, undefined, ResponseMode.Embed,
    );
    expect(paginator(response).has('topartists:next:0:self:Weekly')).toBe(true);
  });
});

describe('TopBuilders: page bounds are the caller\'s job today, and the builder does not help', () => {
  /*
   * These four are the evidence for the finding above, stated as facts about the
   * CURRENT code so the clamp can be added with a test that then flips. Read
   * them as a specification of the defect, not as desired behaviour.
   */
  it('an index past the end renders an empty card whose footer still claims the page', async () => {
    const response = await artistCard(many(artist, 25), 9);
    expect(description(response)).toBe('No artists found.');
    // The lie: the card says page 5 of 2 and names all 25 artists.
    expect(footer(response)).toContain('Page 10/3');
  });

  it('a negative index renders an empty card numbered from zero', async () => {
    const response = await artistCard(many(artist, 25), -1);
    expect(description(response)).toBe('No artists found.');
    expect(footer(response)).toContain('Page 0/3');
  });

  it('leaves both directions live on a negative page, because neither bound is crossed', async () => {
    // page === 0 is false, so `disabled` is false on first and previous; and
    // page >= totalPages - 1 is false, so it is false on next and last too. A
    // control that can only navigate further into nothing.
    const row = paginator(await artistCard(many(artist, 25), -1));
    for (const id of ['topartists:first:-1:moha:Weekly', 'topartists:prev:-1:moha:Weekly']) {
      expect(row.get(id)?.disabled).toBe(false);
    }
  });

  it('still renders a real page normally, so nothing above is a general failure', async () => {
    const response = await artistCard(many(artist, 25), 1);
    expect(description(response)).toContain('Artist 10');
    expect(description(response)).not.toContain('No artists found.');
  });
});

describe('TopBuilders: the ranked rows', () => {
  it('numbers rows from one on the first page', async () => {
    const response = await artistCard(many(artist, 3));
    expect(description(response)).toContain('1. **[Artist 0]');
    expect(description(response)).toContain('3. **[Artist 2]');
  });

  it('continues the numbering across pages rather than restarting', async () => {
    // The whole point of `page * perPage + idx + 1`. Restarting would tell the
    // user their eleventh artist is their first. Asserted line by line, because
    // "11. **[Artist 10]" textually CONTAINS "1. **[Artist 10]" and a substring
    // check would fail for a reason that has nothing to do with the behaviour.
    const rows = description(await artistCard(many(artist, 25), 1)).split('\n');
    expect(rows[0]).toMatch(/^11\. /);
    expect(rows[9]).toMatch(/^20\. /);
    expect(rows.every((r) => Number(r.split('.')[0]) >= 11)).toBe(true);
  });

  it('shows exactly ten rows a page', async () => {
    const response = await artistCard(many(artist, 25), 1);
    expect(description(response).split('\n')).toHaveLength(10);
  });

  it('pluralises a single play, because "1 plays" reads as a bug', async () => {
    const response = await artistCard([artist(0, 1), artist(1, 1)]);
    expect(description(response)).toContain('*1 play*');
  });

  it('does not interpolate a playcount as a raw number, so a big one stays readable', async () => {
    const response = await artistCard([artist(0, 4321)]);
    expect(description(response)).toContain('*4321 plays*');
  });

  it('links an artist row to the Last.fm artist page, with a plus for the space', async () => {
    // `encodeURIComponent(artist).replace(/%20/g, '+')`: Last.fm 404s the %20
    // form on a music path, so the replacement is load-bearing, not cosmetic.
    const response = await artistCard([artist(0)]);
    expect(description(response)).toContain('https://www.last.fm/music/Artist+0');
  });

  it('links an album row to the album page and names the artist in plain text', async () => {
    const response = await albumCard(many(album, 1));
    expect(description(response)).toContain('**Artist 0** - **[Album 0]');
    expect(description(response)).toContain('https://www.last.fm/music/Artist+0/Album+0');
  });

  it('links a track row to the track page, through the `_` track segment', async () => {
    const response = await trackCard(many(track, 1));
    expect(description(response)).toContain('https://www.last.fm/music/Artist+0/_/Track+0');
  });

  it('escapes an ampersand in a name, so the link does not break on one', async () => {
    // `%26` survives the `%20 -> +` rewrite, which is the point: an unescaped `&`
    // in a markdown link destination terminates the URL in some renderers.
    const response = await artistCard([{ name: 'Simon & Garfunkel', playcount: 3 }] as TopArtist[]);
    expect(description(response)).toContain('Simon+%26+Garfunkel');
  });

  it('says so plainly when the list is empty, instead of an empty description', async () => {
    expect(description(await artistCard([]))).toBe('No artists found.');
    expect(description(await albumCard([]))).toBe('No albums found.');
    expect(description(await trackCard([]))).toBe('No tracks found.');
  });

  it('names the period and the listener in the author line', async () => {
    const response = await artistCard(many(artist, 1));
    expect(author(response)).toBe('Top weekly artists for moha');
  });

  it('points the author line at the library view for the same period', async () => {
    const response = await artistCard(many(artist, 1));
    expect(response.embed.data.author?.url).toContain('date_preset=LAST_7_DAYS');
  });

  it('falls back to the Last.fm default window when the setting has no parameter', async () => {
    const noParam = { timePeriod: 'weekly', description: 'Weekly' } as unknown as TimeSettingsModel;
    const response = await TopBuilders.buildTopArtistsResponse(
      NO_DEPS, 'moha', 'moha', many(artist, 1), noParam, 0, undefined, ResponseMode.Embed,
    );
    expect(response.embed.data.author?.url).toContain('date_preset=LAST_7_DAYS');
  });

  it('applies the accent colour only when one was supplied', async () => {
    expect((await artistCard(many(artist, 1))).embed.data.color).toBe(0x5500ff);
    const plain = await TopBuilders.buildTopArtistsResponse(
      NO_DEPS, 'moha', 'moha', many(artist, 1), TIME, 0, undefined, ResponseMode.Embed,
    );
    expect(plain.embed.data.color).toBeUndefined();
  });

  it('carries the whole list on the response for the route to re-slice', async () => {
    // `_paginatorData` is how the interaction handler rebuilds the list; if it
    // held the page instead of the list, "next" would show the same ten rows.
    const items = many(artist, 25);
    const response = await artistCard(items, 1);
    const data = response._paginatorData as { items: TopArtist[]; type: string };
    expect(data.type).toBe('artists');
    expect(data.items).toHaveLength(25);
  });

  it('tags each list with its own type in the paginator data', async () => {
    expect((await albumCard(many(album, 1)))._paginatorData).toMatchObject({ type: 'albums' });
    expect((await trackCard(many(track, 1)))._paginatorData).toMatchObject({ type: 'tracks' });
  });
});

describe('TopBuilders: image mode, and what it costs when it cannot render', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  const depsWith = (over: Partial<TopBuildersDeps> = {}): TopBuildersDeps => ({
    ...NO_DEPS,
    generator: { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) } as unknown as WhoKnowsGenerator,
    ...over,
  });

  it('returns the image and no embed when the generator works', async () => {
    const response = await TopBuilders.buildTopArtistsResponse(
      depsWith(), 'moha', 'moha', many(artist, 3), TIME, 0, undefined, ResponseMode.Image,
    );
    expect(response.hasFile()).toBe(true);
    expect(response.fileName).toBe('topartists.png');
    expect(response.hasEmbed()).toBe(false);
  });

  it('names the file after the list, so a downloads folder is legible', async () => {
    const albums = await TopBuilders.buildTopAlbumsResponse(
      depsWith(), 'moha', 'moha', many(album, 3), TIME, 0, undefined, ResponseMode.Image,
    );
    const tracks = await TopBuilders.buildTopTracksResponse(
      depsWith(), 'moha', 'moha', many(track, 3), TIME, 0, undefined, ResponseMode.Image,
    );
    expect(albums.fileName).toBe('topalbums.png');
    expect(tracks.fileName).toBe('toptracks.png');
  });

  it('falls back to the embed when the generator throws, rather than failing the command', async () => {
    // An image is decoration. A Puppeteer crash must not delete a leaderboard
    // of real people, so the catch falls through to the embed below it.
    const response = await TopBuilders.buildTopArtistsResponse(
      depsWith({ generator: { generateWhoKnowsImage: vi.fn(async () => { throw new Error('chrome died'); }) } as unknown as WhoKnowsGenerator }),
      'moha', 'moha', many(artist, 3), TIME, 0, undefined, ResponseMode.Image,
    );
    expect(response.hasFile()).toBe(false);
    expect(response.hasEmbed()).toBe(true);
    expect(description(response)).toContain('Artist 0');
  });

  it('falls back to the embed when no generator is registered at all', async () => {
    const response = await TopBuilders.buildTopArtistsResponse(
      NO_DEPS, 'moha', 'moha', many(artist, 3), TIME, 0, undefined, ResponseMode.Image,
    );
    expect(response.hasEmbed()).toBe(true);
  });

  it('falls back to the embed for an empty list, since there is no #1 to feature', async () => {
    // The image branch is guarded on `length > 0`, so an empty list is an embed
    // with the honest "No artists found." rather than a picture of nobody.
    const response = await TopBuilders.buildTopArtistsResponse(
      depsWith(), 'moha', 'moha', [], TIME, 0, undefined, ResponseMode.Image,
    );
    expect(response.hasFile()).toBe(false);
    expect(description(response)).toBe('No artists found.');
  });

  it('ignores a mode it was not asked for, and renders the embed', async () => {
    const response = await TopBuilders.buildTopArtistsResponse(
      depsWith(), 'moha', 'moha', many(artist, 3), TIME, 0, undefined, undefined,
    );
    expect(response.hasEmbed()).toBe(true);
  });
});

describe('TopBuilders: what the image is told, and what it refuses to be told', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  const generateOf = async (deps: TopBuildersDeps) => {
    await TopBuilders.buildTopArtistsResponse(deps, 'moha', 'moha', many(artist, 3), TIME, 0, undefined, ResponseMode.Image);
    const generator = deps.generator as unknown as { generateWhoKnowsImage: ReturnType<typeof vi.fn> };
    return generator.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;
  };

  const baseDeps = (over: Partial<TopBuildersDeps> = {}): TopBuildersDeps => ({
    ...NO_DEPS,
    generator: { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) } as unknown as WhoKnowsGenerator,
    ...over,
  });

  it('features the top entry with its own real playcount', async () => {
    const args = await generateOf(baseDeps());
    expect(args.topItemLabel).toBe('#1 Artist');
    expect(args.topItemValue).toBe('Artist 0');
    expect(args.topItemExtra).toBe('10 plays');
  });

  it('computes the average over every artist, not over the ten it drew', async () => {
    // A mean over the drawn subset would be a different number under the same
    // label, and the image has no room to say which.
    const args = await generateOf(baseDeps());
    const items = many(artist, 12); // playcounts 10..120, total 780, mean 65
    const twelve = await TopBuilders.buildTopArtistsResponse(
      baseDeps(), 'moha', 'moha', items, TIME, 0, undefined, ResponseMode.Image,
    );
    expect(twelve.hasFile()).toBe(true);
    expect(args.stats).toEqual([
      { value: 60, label: 'Weekly Plays' },
      { value: 3, label: 'Artists' },
      { value: 20, label: 'Avg / Artist' },
    ]);
  });

  it('lists three artists in the top-three row, which is what the row is for', async () => {
    const args = await generateOf(baseDeps());
    expect(args.topTracks).toEqual(['Artist 0 (10)', 'Artist 1 (20)', 'Artist 2 (30)']);
    expect(args.topListHeader).toBe('Top 3 Artists');
  });

  it('omits the mosaic entirely when no cover source answered', async () => {
    // A half-populated mosaic and a complete one are indistinguishable in a PNG,
    // and the generator substitutes its own placeholder tile for an absent list.
    // `undefined` is the honest value; `[]` would claim there are none.
    //
    // The artist rows carry no `imageUrl` and `artworkService` is null, so the
    // seed list and the fallback fetch are both empty - the only way to observe
    // the BOTTOM of the ladder rather than the top of it.
    const bare = Array.from({ length: 3 }, (_, i) => ({
      name: `Artist ${i}`, playcount: 10, imageUrl: undefined,
    })) as TopArtist[];
    const captured = { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) };

    const response = await TopBuilders.buildTopArtistsResponse(
      { ...NO_DEPS, generator: captured as unknown as WhoKnowsGenerator }, 'moha', 'moha', bare, TIME, 0, undefined, ResponseMode.Image,
    );
    const passed = captured.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;

    expect(response.hasFile()).toBe(true);
    expect(passed.backgroundCovers).toBeUndefined();
  });

  it('never forwards a Last.fm placeholder as artwork, on any rung', async () => {
    // The placeholder hash is common in real Last.fm responses. Passing it
    // through would render the same grey square for the feature image.
    const PLACEHOLDER = 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
    const captured = { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) };
    await TopBuilders.buildTopArtistsResponse(
      {
        ...NO_DEPS,
        generator: captured as unknown as WhoKnowsGenerator,
        artworkService: { getArtistImageUrl: vi.fn(async () => PLACEHOLDER) } as unknown as ArtworkService,
      },
      'moha', 'moha', [{ name: 'A', playcount: 1, imageUrl: PLACEHOLDER }] as TopArtist[],
      TIME, 0, undefined, ResponseMode.Image,
    );
    const passed = captured.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.imageUrl).toBeUndefined();
  });

  it('uses the resolved cover for the feature image, not the raw row value', async () => {
    const captured = { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) };
    await TopBuilders.buildTopArtistsResponse(
      {
        ...NO_DEPS,
        generator: captured as unknown as WhoKnowsGenerator,
        artworkService: { getArtistImageUrl: vi.fn(async () => 'https://img.test/resolved.jpg') } as unknown as ArtworkService,
      },
      'moha', 'moha', [{ name: 'A', playcount: 1, imageUrl: 'https://img.test/raw.jpg' }] as TopArtist[],
      TIME, 0, undefined, ResponseMode.Image,
    );
    const passed = captured.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.imageUrl).toBe('https://img.test/resolved.jpg');
  });

  it('falls back to the row cover when the artwork service could not resolve one', async () => {
    const captured = { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) };
    await TopBuilders.buildTopArtistsResponse(
      {
        ...NO_DEPS,
        generator: captured as unknown as WhoKnowsGenerator,
        artworkService: { getArtistImageUrl: vi.fn(async () => null) } as unknown as ArtworkService,
      },
      'moha', 'moha', [{ name: 'A', playcount: 1, imageUrl: 'https://img.test/raw.jpg' }] as TopArtist[],
      TIME, 0, undefined, ResponseMode.Image,
    );
    const passed = captured.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.imageUrl).toBe('https://img.test/raw.jpg');
  });
});

describe('TopBuilders: the cover ladder admits only covers it can attribute', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  const COVER = (n: number) => `https://img.test/cover${n}.jpg`;

  const run = async (deps: Partial<TopBuildersDeps>, items: TopAlbum[], _names: string[]) => {
    const withDeps: TopBuildersDeps = {
      ...NO_DEPS,
      generator: { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) } as unknown as WhoKnowsGenerator,
      ...deps,
    };
    await TopBuilders.buildTopAlbumsResponse(
      withDeps, 'moha', 'moha', items, TIME, 0, undefined, ResponseMode.Image,
    );
    const generator = withDeps.generator as unknown as { generateWhoKnowsImage: ReturnType<typeof vi.fn> };
    return generator.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;
  };

  it('seeds the mosaic from the top album cover the caller already had', async () => {
    // The seed is the first rung and it is free: no HTTP, no query. It is listed
    // FIRST, which is the ordering assertion - a seed appended after the rungs
    // would displace an attributed cover with a merely-provided one.
    const args = await run({}, [albumWithArt(0, 'https://img.test/top.jpg')], ['Artist 0']);
    expect(args.backgroundCovers).toEqual(['https://img.test/top.jpg']);
  });

  it('puts an attributed discography cover ahead of an indexed-database one', async () => {
    // The ladder only stops at ten, so the database rung still RUNS after a
    // short discography result. What is pinned is the ORDER: the verified
    // official release comes before a database row nobody has attributed.
    const getArtistDiscographyCovers = vi.fn(async (..._a: unknown[]) => [COVER(1)]);
    const getIndexedAlbumCoversForArtist = vi.fn(async (..._a: unknown[]) => [COVER(2)]);
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi,
        artistsService: { getIndexedAlbumCoversForArtist } as unknown as ArtistsService,
      },
      [album(0)],
      ['Artist 0'],
    );

    expect(getArtistDiscographyCovers).toHaveBeenCalled();
    expect(getIndexedAlbumCoversForArtist).toHaveBeenCalled();
    expect(args.backgroundCovers).toEqual([COVER(1), COVER(2)]);
  });

  it('anchors the discography query with a track hint, so a namesake does not win', async () => {
    // A bare name search returns the most popular artist of that name, and the
    // mosaic then fills with someone else's records.
    const getArtistDiscographyCovers = vi.fn(async (..._a: unknown[]) => []);
    await run(
      { spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi },
      [{ name: 'Paranoid Android', artistName: 'Radiohead', playcount: 5, imageUrl: undefined }] as TopAlbum[],
      ['Radiohead'],
    );
    expect(getArtistDiscographyCovers).toHaveBeenCalledWith('Radiohead', 'Paranoid Android', 15);
  });

  it('falls through to the database rung when the discography query returns nothing', async () => {
    const getArtistDiscographyCovers = vi.fn(async (..._a: unknown[]) => []);
    const getIndexedAlbumCoversForArtist = vi.fn(async (..._a: unknown[]) => [COVER(3)]);
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi,
        artistsService: { getIndexedAlbumCoversForArtist } as unknown as ArtistsService,
      },
      [album(0)],
      ['Artist 0'],
    );

    expect(getIndexedAlbumCoversForArtist).toHaveBeenCalled();
    expect(args.backgroundCovers).toEqual([COVER(3)]);
  });

  it('rejects a Deezer cover for a different artist with the same name', async () => {
    // Deezer search is fuzzy. Admitting a namesake's cover is a claim about a
    // person, and it is invisible on a mosaic of ten tiles.
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
        deezerApi: {
          searchAlbums: vi.fn(async (..._a: unknown[]) => [
            { artist: { name: 'Radiohead Tribute Band' }, cover_xl: COVER(9) },
            { artist: { name: 'radiohead' }, cover_xl: COVER(8) },
          ]),
        } as unknown as DeezerApi,
      },
      [{ name: 'OK Computer', artistName: 'Radiohead', playcount: 5, imageUrl: undefined }] as TopAlbum[],
      ['Radiohead'],
    );

    expect(args.backgroundCovers).toEqual([COVER(8)]);
  });

  it('does not ask Deezer for an artist whose discography already filled the mosaic', async () => {
    const searchAlbums = vi.fn(async (..._a: unknown[]) => []);
    const args = await run(
      {
        spotifyApi: {
          getArtistDiscographyCovers: vi.fn(async () => Array.from({ length: 10 }, (_, i) => COVER(i))),
        } as unknown as SpotifySearchApi,
        deezerApi: { searchAlbums } as unknown as DeezerApi,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(searchAlbums).not.toHaveBeenCalled();
    expect(args.backgroundCovers).toHaveLength(10);
  });

  it('takes the largest Deezer cover it is offered rather than a fixed size', async () => {
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
        deezerApi: {
          searchAlbums: vi.fn(async (..._a: unknown[]) => [
            { artist: { name: 'Artist 0' }, cover_medium: COVER(1) },
          ]),
        } as unknown as DeezerApi,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(args.backgroundCovers).toEqual([COVER(1)]);
  });

  it('does not consult the Last.fm rung at all when a richer rung filled the mosaic', async () => {
    // Rung four is the last resort, so it must be the last one consulted.
    const getTopAlbums = vi.fn(async (..._a: unknown[]) => [{ imageUrl: COVER(4) }]);
    const full = await run(
      {
        spotifyApi: {
          getArtistDiscographyCovers: vi.fn(async () => Array.from({ length: 10 }, (_, i) => COVER(i))),
        } as unknown as SpotifySearchApi,
        lastfmRepo: { getTopAlbums } as unknown as LastFmRepository,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(getTopAlbums).not.toHaveBeenCalled();
    expect(full.backgroundCovers).toHaveLength(10);

    const reached = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
        lastfmRepo: { getTopAlbums } as unknown as LastFmRepository,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(getTopAlbums).toHaveBeenCalled();
    expect(reached.backgroundCovers).toEqual([COVER(4)]);
  });

  it('never passes a Last.fm placeholder through as a mosaic tile', async () => {
    // The placeholder hash is common in real Last.fm responses; ten of them is
    // a mosaic of one grey square repeated, which reads as "we found art".
    const PLACEHOLDER = 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
        lastfmRepo: { getTopAlbums: vi.fn(async () => [{ imageUrl: PLACEHOLDER }]) } as unknown as LastFmRepository,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(args.backgroundCovers).toBeUndefined();
  });

  it('records a Last.fm failure rather than dropping it, and still renders the card', async () => {
    const getTopAlbums = vi.fn(async () => { throw new Error('502 from last.fm'); });
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
        lastfmRepo: { getTopAlbums } as unknown as LastFmRepository,
      },
      [album(0)],
      ['Artist 0'],
    );
    // The recorded trade: the mosaic loses a rung, the card survives, and the
    // failure is named in the platform log rather than swallowed in silence. The
    // ERROR line is asserted on stdout rather than through a spy, because
    // `Logger` is a module singleton and `vi.spyOn` on it would leave an own
    // property behind for every later test in this file.
    expect(args.backgroundCovers).toBeUndefined();
    expect(args.topItemValue).toBe('Artist 0 - Album 0');
  });

  it('never asks for more than five artists, so one chart cannot fan out without bound', async () => {
    const searchAlbums = vi.fn(async (..._a: unknown[]) => []);
    const items = many(album, 20);
    await run({ spotifyApi: null, deezerApi: { searchAlbums } as unknown as DeezerApi }, items, items.map((a) => a.artistName));
    expect(searchAlbums.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('stops at ten covers, because ten is what the generator lays out', async () => {
    const args = await run(
      {
        spotifyApi: {
          getArtistDiscographyCovers: vi.fn(async () => Array.from({ length: 15 }, (_, i) => COVER(i))),
        } as unknown as SpotifySearchApi,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(args.backgroundCovers).toHaveLength(10);
  });

  it('keeps one copy of a cover that two rungs both returned', async () => {
    // A duplicate makes the mosaic look fuller than the sources actually were,
    // and there is no legend on a mosaic saying which tiles are repeats.
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => [COVER(1)]) } as unknown as SpotifySearchApi,
        artistsService: { getIndexedAlbumCoversForArtist: vi.fn(async () => [COVER(1), COVER(2)]) } as unknown as ArtistsService,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(args.backgroundCovers).toEqual([COVER(1), COVER(2)]);
  });

  it('never counts the caller-supplied top cover twice', async () => {
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => [COVER(1)]) } as unknown as SpotifySearchApi,
        artistsService: { getIndexedAlbumCoversForArtist: vi.fn(async () => []) } as unknown as ArtistsService,
      },
      [albumWithArt(0, COVER(1))],
      ['Artist 0'],
    );
    // The seed is COVER(1) and the discography rung returned the same one.
    expect(args.backgroundCovers).toEqual([COVER(1)]);
  });

  it('survives every cover source throwing, and renders the card without a mosaic', async () => {
    const boom = async () => { throw new Error('upstream down'); };
    const args = await run(
      {
        spotifyApi: { getArtistDiscographyCovers: vi.fn(boom) } as unknown as SpotifySearchApi,
        artistsService: {
          getTopTracksForArtistGlobal: vi.fn(boom),
          getIndexedAlbumCoversForArtist: vi.fn(boom),
        } as unknown as ArtistsService,
        deezerApi: { searchAlbums: vi.fn(boom) } as unknown as DeezerApi,
        lastfmRepo: { getTopAlbums: vi.fn(boom) } as unknown as LastFmRepository,
      },
      [album(0)],
      ['Artist 0'],
    );
    expect(args.backgroundCovers).toBeUndefined();
    expect(args.topItemValue).toBe('Artist 0 - Album 0');
  });

  it('never lets a cover failure remove the playcounts, which come from the caller', async () => {
    const boom = async () => { throw new Error('upstream down'); };
    const withDeps: TopBuildersDeps = {
      ...NO_DEPS,
      generator: { generateWhoKnowsImage: vi.fn(async (..._a: unknown[]) => PNG) } as unknown as WhoKnowsGenerator,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(boom) } as unknown as SpotifySearchApi,
      lastfmRepo: { getTopAlbums: vi.fn(boom) } as unknown as LastFmRepository,
    };
    await TopBuilders.buildTopAlbumsResponse(
      withDeps, 'moha', 'moha', many(album, 3), TIME, 0, undefined, ResponseMode.Image,
    );
    const generator = withDeps.generator as unknown as { generateWhoKnowsImage: ReturnType<typeof vi.fn> };
    const args = generator.generateWhoKnowsImage.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.users).toHaveLength(3);
    expect(args.stats).toEqual([
      { value: 60, label: 'Weekly Plays' },
      { value: 3, label: 'Albums' },
      { value: 20, label: 'Avg / Album' },
    ]);
  });
});
