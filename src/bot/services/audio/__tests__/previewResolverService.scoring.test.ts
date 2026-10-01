import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreviewResolverService } from '../previewResolverService';
import type { AppleMusicSearchApi } from '@applemusic/apis/appleMusicSearchApi';
import type { DeezerApi } from '@deezer/apis/deezerApi';
import type { CacheService } from '../../system/cacheService';
import type { ITunesSearchResult } from '@applemusic/models/itunesModels';
import type { DeezerTrack } from '@deezer/models/deezerModels';

/**
 * The candidate-scoring path of `previewResolverService.ts`.
 *
 * `previewResolverService.ttl.test.ts` pins the cache TTL. This file covers the
 * other half: the hand-rolled point system in `searchApple` / `searchDeezer`,
 * which decides WHICH of a provider's results is treated as the requested song.
 * That decision is the one that can quietly lie — a resolver that returns a
 * confidently wrong track is worse than one that returns nothing, because the
 * user gets a preview button that plays something else.
 *
 * ── Why the scoring is tested from the OUTSIDE ──
 * The scorer is private, so every assertion here goes through the public
 * `resolve()`. That is deliberate: the number 5000 means nothing on its own,
 * whereas "the right recording wins and the wrong artist is refused" is a
 * contract worth pinning. All expectations below were taken from the real
 * implementation, not from reading it — see the two behaviours that reading the
 * source alone would have got wrong, both documented inline:
 *
 *   1. `searchDeezer` has NO wrong-artist penalty. `searchApple` takes -2000
 *      for a mismatched artist (line 175); the Deezer scorer has no equivalent
 *      rule at all. On Deezer a wrong-artist candidate can therefore WIN the
 *      sort, and the only thing that stops it is the `validateArtist` guard on
 *      the chosen row (line 260).
 *   2. That guard is all-or-nothing. It refuses the chosen candidate and the
 *      whole resolution becomes `null`; it does not drop the bad row and
 *      re-pick the runner-up. So a good candidate sitting at index 1 is thrown
 *      away with the bad one at index 0.
 *
 * There is a THIRD guard now, added 2026-09-30: `validateTrack`, on the chosen
 * row, reusing `artworkService`'s `matchesTrackTitle`. Without it a right-artist
 * / wrong-track row was returned with a working preview button. Section 3b
 * covers it, and the BUG REPORT at the bottom records what it did and did not
 * close.
 *
 * See BUG REPORT at the bottom of this file for the two mis-attribution bugs
 * these tests pin down rather than paper over.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * `previewUrl` is typed `string | undefined` on `ITunesSearchResult`, but the
 * iTunes search API genuinely returns `null` for a track with no preview, and
 * the service handles it with `chosen.previewUrl ?? null`. Modelling it as
 * `undefined`-only would make the "empty preview falls through to the next
 * rung" test impossible to write — which is the case this file exists to cover.
 */
type AppleRowOverride = Partial<Omit<ITunesSearchResult, 'previewUrl'>> & {
  previewUrl?: string | null;
};

const appleRow = (over: AppleRowOverride = {}): ITunesSearchResult => ({
  trackName: 'Creep',
  artistName: 'Radiohead',
  collectionName: 'Pablo Honey',
  trackTimeMillis: 239_000,
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a',
  trackViewUrl: 'https://music.apple.com/us/album/creep/123',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/abc100x100bb.jpg',
  ...over,
  // The cast documents a real disagreement between the declared type and the
  // wire: iTunes genuinely sends `null` where the type says `undefined`. The
  // service copes with `?? null`, so the fixtures are allowed to be honest
  // about the wire rather than forcing every case through `undefined`.
} as ITunesSearchResult);

/**
 * Deezer's `preview` is typed `string | undefined` but the API genuinely
 * returns `null` for a track with no preview, same as iTunes above.
 */
type DeezerRowOverride = Partial<Omit<DeezerTrack, 'preview'>> & {
  preview?: string | null;
};

const deezerRow = (over: DeezerRowOverride = {}): DeezerTrack => ({
  id: 42,
  title: 'Creep',
  duration: 239,
  link: 'https://www.deezer.com/track/42',
  preview: 'https://cdns-preview.dzcdn.net/helper.php?hash=abc',
  artist: { id: 1, name: 'Radiohead' },
  album: { id: 7, title: 'Pablo Honey', cover_xl: 'https://cdn.example/xl.jpg' },
  ...over,
} as DeezerTrack);

// ── Doubles ─────────────────────────────────────────────────────────────────
// The rest parameter is load-bearing, not decoration: a zero-arg `vi.fn`
// infers a `[]` call tuple, so `calls[0][1]` is a COMPILE error (TS2493) that
// `vitest run` never reports. `npm test` passes; `tsc` does not.
const cacheDouble = (seed: unknown = null) => {
  const get = vi.fn(async (..._args: unknown[]) => seed);
  const set = vi.fn(async (..._args: unknown[]) => undefined);
  return { cache: { get, set } as unknown as CacheService, get, set };
};

const build = (over: {
  apple?: unknown;
  deezer?: unknown;
  cached?: unknown;
  scraper?: unknown;
}) => {
  const { cache, get, set } = cacheDouble(over.cached ?? null);
  // searchSongs(query, artist?, limit?) -> ITunesSearchResult[]
  const searchSongs = vi.fn(async (..._args: unknown[]) => over.apple ?? []);
  // searchTracks(query, limit) -> DeezerTrack[]
  const searchTracks = vi.fn(async (..._args: unknown[]) => over.deezer ?? []);
  const svc = new PreviewResolverService(
    { searchSongs } as unknown as AppleMusicSearchApi,
    { searchTracks } as unknown as DeezerApi,
    cache,
    over.scraper as never,
  );
  return { svc, searchSongs, searchTracks, get, set };
};

const winner = (r: Awaited<ReturnType<PreviewResolverService['resolve']>>) => ({
  source: r?.source,
  track: r?.trackName,
  artist: r?.artistName,
  album: r?.albumName,
  preview: r?.previewUrl,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Exact title + artist outranks a partial match ────────────────────────

describe('scoring — an exact title+artist match outranks a partial one', () => {
  it('APPLE: picks the exact row even when the partial row is listed FIRST', async () => {
    // Order matters here on purpose. Search APIs rank by their own text
    // relevance, so the remastered row really does come back first in
    // production; a resolver that trusted provider order would return
    // "Creep (Remastered 2016)". The scorer must not.
    const { svc } = build({
      apple: [
        appleRow({ trackName: 'Creep (Remastered 2016)', previewUrl: 'https://a/partial.m4a' }),
        appleRow({ previewUrl: 'https://a/exact.m4a' }),
      ],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(winner(result)).toEqual({
      source: 'apple', track: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', preview: 'https://a/exact.m4a',
    });
  });

  it('APPLE: the exact row still wins when it is listed first (order-independence)', async () => {
    // The mirror of the test above. Without both, an implementation that simply
    // took `valid[0]` after a no-op sort would pass one and fail the other.
    const { svc } = build({
      apple: [
        appleRow({ previewUrl: 'https://a/exact.m4a' }),
        appleRow({ trackName: 'Creep (Remastered 2016)', previewUrl: 'https://a/partial.m4a' }),
      ],
    });

    expect((await svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://a/exact.m4a');
  });

  it('DEEZER: the exact row beats the remastered row in either order', async () => {
    const rows: DeezerTrack[] = [
      deezerRow({ id: 1, title: 'Creep (Remastered 2016)', preview: 'https://dz/partial.mp3' }),
      deezerRow({ id: 2, preview: 'https://dz/exact.mp3' }),
    ];

    const a = build({ apple: null, deezer: rows });
    const b = build({ apple: null, deezer: [...rows].reverse() });

    expect((await a.svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://dz/exact.mp3');
    expect((await b.svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://dz/exact.mp3');
  });

  it('a lower-ranked exact match is not promoted just for being first', async () => {
    // Guards the specific failure of a scorer that reads "index 0 wins" as a
    // rule: the exact row here is at index 1 and must still take it.
    const { svc } = build({
      apple: [
        appleRow({ trackName: 'Anything At All', artistName: 'Blur', previewUrl: 'https://a/other.m4a' }),
        appleRow({ previewUrl: 'https://a/exact.m4a' }),
      ],
    });

    expect((await svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://a/exact.m4a');
  });
});

// ── 2. The album hint boosts the right candidate ────────────────────────────

describe('scoring — an album hint promotes the recording actually asked for', () => {
  // Two rows, identical artist and title, different albums. The ONLY thing
  // that can separate them is the album hint, so each test here fails if the
  // album scoring is removed, inverted, or applied to the wrong row.
  const twoAlbums: ITunesSearchResult[] = [
    appleRow({ collectionName: 'Kid A', previewUrl: 'https://a/kid-a.m4a' }),
    appleRow({ collectionName: 'Pablo Honey', previewUrl: 'https://a/pablo-honey.m4a' }),
  ];

  it('APPLE: without a hint the earlier row wins (the baseline the hint must beat)', async () => {
    const { svc } = build({ apple: twoAlbums });

    expect((await svc.resolve('Radiohead', 'Creep'))?.albumName).toBe('Kid A');
  });

  it('APPLE: a hint for the SECOND row moves the win to it', async () => {
    const { svc } = build({ apple: twoAlbums });

    const result = await svc.resolve('Radiohead', 'Creep', 'Pablo Honey');

    expect(result?.albumName).toBe('Pablo Honey');
    expect(result?.previewUrl).toBe('https://a/pablo-honey.m4a');
  });

  it('APPLE: a hint for the FIRST row leaves the win where it was', async () => {
    // The other direction. A scorer that added the album bonus to whichever
    // row it liked would still pass the test above; this pins that the boost
    // follows the HINT, not the winner.
    const { svc } = build({ apple: twoAlbums });

    expect((await svc.resolve('Radiohead', 'Creep', 'Kid A'))?.albumName).toBe('Kid A');
  });

  it('APPLE: a partial album name still promotes its row (deluxe/anniversary editions)', async () => {
    // Real catalogue shape: the live version is usually only ever returned as
    // "Pablo Honey (Deluxe Edition)". A strict-equality album bonus would
    // never fire on the rows that matter.
    const { svc } = build({
      apple: [
        appleRow({ collectionName: 'Kid A', previewUrl: 'https://a/kid-a.m4a' }),
        appleRow({ collectionName: 'Pablo Honey (Deluxe Edition)', previewUrl: 'https://a/deluxe.m4a' }),
      ],
    });

    const result = await svc.resolve('Radiohead', 'Creep', 'Pablo Honey');

    expect(result?.albumName).toBe('Pablo Honey (Deluxe Edition)');
    expect(result?.previewUrl).toBe('https://a/deluxe.m4a');
  });

  it('APPLE: a hint matching nothing changes nothing — an absence is not a rejection', async () => {
    const { svc } = build({ apple: twoAlbums });

    const result = await svc.resolve('Radiohead', 'Creep', 'An Album That Does Not Exist');

    // Still resolved, still the first row. A scorer that treated an unmatched
    // hint as a filter would return null here and drop a perfectly good match.
    expect(winner(result)).toEqual({
      source: 'apple', track: 'Creep', artist: 'Radiohead', album: 'Kid A', preview: 'https://a/kid-a.m4a',
    });
  });

  it('DEEZER: the album hint moves the win, and an unmatched hint does not', async () => {
    const rows: DeezerTrack[] = [
      deezerRow({ id: 1, album: { id: 1, title: 'Kid A' }, preview: 'https://dz/kid-a.mp3' }),
      deezerRow({ id: 2, album: { id: 2, title: 'Pablo Honey' }, preview: 'https://dz/pablo.mp3' }),
    ];

    const hinted = build({ apple: null, deezer: rows });
    const unhinted = build({ apple: null, deezer: rows });
    const bogus = build({ apple: null, deezer: rows });

    expect((await hinted.svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.previewUrl).toBe('https://dz/pablo.mp3');
    expect((await unhinted.svc.resolve('Radiohead', 'Creep'))?.albumName).toBe('Kid A');
    expect((await bogus.svc.resolve('Radiohead', 'Creep', 'Nowhere Land'))?.albumName).toBe('Kid A');
  });

  it('DEEZER: a partial album name promotes its row on the smaller bonus tier', async () => {
    // The Deezer half of the two-tier album bonus. Both rows match the hint
    // here, so only the size of the tier (+3500 vs +1500) can separate them.
    const { svc } = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, album: { id: 1, title: 'Pablo Honey (Deluxe Edition)' }, preview: 'https://dz/deluxe.mp3' }),
        deezerRow({ id: 2, album: { id: 2, title: 'Pablo Honey' }, preview: 'https://dz/pablo.mp3' }),
      ],
    });

    expect((await svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.albumName).toBe('Pablo Honey');
  });

  it('APPLE: when BOTH rows satisfy the hint, the exact album name beats the partial one', async () => {
    // The two tiers of the album bonus (+3500 exact, +1500 partial) are
    // otherwise indistinguishable: any test where only one row matches the
    // hint passes with either tier, because even the smaller one outweighs the
    // index bonus. These are the only fixtures where the tiers separate. Both
    // orders are needed — with the exact row first, an implementation that
    // ignored the tier entirely and just took the first row would pass.
    const hinted = [
      appleRow({ collectionName: 'Pablo Honey (Deluxe Edition)', previewUrl: 'https://a/partial.m4a' }),
      appleRow({ collectionName: 'Pablo Honey', previewUrl: 'https://a/exact.m4a' }),
    ];

    const a = build({ apple: hinted });
    const b = build({ apple: [...hinted].reverse() });

    expect((await a.svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.albumName).toBe('Pablo Honey');
    expect((await b.svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.albumName).toBe('Pablo Honey');
  });

  it('an album hint cannot rescue a row for the wrong artist', async () => {
    // The album boost is +3500, which is large enough to outrank the correct
    // artist. It must not become a way to smuggle a different artist through.
    const { svc } = build({
      apple: [
        appleRow({ collectionName: 'Pablo Honey', previewUrl: 'https://a/right.m4a' }),
        appleRow({ artistName: 'Oasis', collectionName: 'Pablo Honey', previewUrl: 'https://a/wrong.m4a' }),
      ],
    });

    expect((await svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.previewUrl).toBe('https://a/right.m4a');
  });
});

// ── 3. THE WRONG-ARTIST GUARD (the most valuable tests in this file) ─────────

describe('scoring — a wrong-artist candidate is refused, however good its title', () => {
  // "Oasis" recording "Creep" with a real preview URL is precisely the row
  // that produces a confidently mis-attributed song: the user asked for a
  // Radiohead track, gets a preview button, and it plays someone else.

  it('APPLE: a perfect-title wrong-artist candidate is refused outright', async () => {
    const { svc } = build({
      apple: [appleRow({ artistName: 'Oasis', collectionName: "(What's The Story) Morning Glory?", previewUrl: 'https://a/oasis.m4a' })],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('APPLE: the refusal is not merely a lost race — it holds with several wrong artists', async () => {
    const { svc } = build({
      apple: [
        appleRow({ artistName: 'Oasis', previewUrl: 'https://a/oasis.m4a' }),
        appleRow({ artistName: 'Blur', previewUrl: 'https://a/blur.m4a' }),
        appleRow({ artistName: 'The Verve', previewUrl: 'https://a/verve.m4a' }),
      ],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('APPLE: adding an exact-artist row makes the resolver work again (both directions)', async () => {
    // The AGENTS.md rule for a fix and a bug that are opposites: a failure
    // raises AND a genuine match still returns. The guard must reject the
    // wrong artist without poisoning queries that do have a right answer.
    const { svc } = build({
      apple: [
        appleRow({ artistName: 'Oasis', previewUrl: 'https://a/oasis.m4a' }),
        appleRow({ previewUrl: 'https://a/radiohead.m4a' }),
      ],
    });

    expect((await svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://a/radiohead.m4a');
  });

  it('DEEZER: a perfect-title wrong-artist candidate is refused outright', async () => {
    const { svc } = build({
      apple: null,
      deezer: [deezerRow({ id: 1, artist: { id: 9, name: 'Oasis' }, album: { id: 1, title: 'Morning Glory' }, preview: 'https://dz/oasis.mp3' })],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('DEEZER: when the wrong artist OUTSCORES the right one, the resolver refuses rather than swapping', async () => {
    // THE INTERESTING CASE, and the one reading the source would not predict.
    // `searchDeezer` has no wrong-artist penalty (unlike `searchApple`), so on
    // these two rows the wrong artist WINS the sort:
    //   idx 0  Oasis / "Creep"      exact title, wrong artist -> 2000 + 150
    //   idx 1  Radiohead / "Karma Police"  wrong title, right artist
    //                              -> 2000 + 1000 - 1000 + 140
    // The only thing standing between that and a mis-attributed preview is
    // the `validateArtist` guard on the chosen row. This test is that guard's
    // regression test, and it is why the two rows are in this order.
    const { svc } = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, title: 'Creep', artist: { id: 9, name: 'Oasis' }, album: { id: 1, title: 'Morning Glory' }, preview: 'https://dz/oasis.mp3' }),
        deezerRow({ id: 2, title: 'Karma Police', artist: { id: 1, name: 'Radiohead' }, album: { id: 2, title: 'OK Computer' }, preview: 'https://dz/radiohead.mp3' }),
      ],
    });

    // Null, NOT "Karma Police": refusing beats returning a wrong artist, and
    // the good row at index 1 is discarded along with the bad one at index 0.
    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('DEEZER: the same pair in the other order refuses TOO, on the track guard', async () => {
    // INVERTED 2026-09-30. This test used to assert
    // `artistName === 'Radiohead'` here — i.e. it PINNED the worst live defect
    // in the bot. Swap the rows so the right-artist row wins the sort and the
    // resolver answered with "Karma Police" for a request for "Creep": a wrong
    // song, with a working preview button, presented as the right one. Its
    // purpose — proving the null above comes from a GUARD rather than a scoring
    // accident — survives the fix and is now sharper, because the two orders
    // refuse for two DIFFERENT reasons:
    //   order as written  -> `validateArtist` refuses the top-scoring row
    //   order reversed    -> `validateTrack` refuses the right-artist row
    // A resolver that only had one of the two guards would pass one of them.
    const { svc } = build({
      apple: null,
      deezer: [
        deezerRow({ id: 2, title: 'Karma Police', artist: { id: 1, name: 'Radiohead' }, album: { id: 2, title: 'OK Computer' }, preview: 'https://dz/radiohead.mp3' }),
        deezerRow({ id: 1, title: 'Creep', artist: { id: 9, name: 'Oasis' }, album: { id: 1, title: 'Morning Glory' }, preview: 'https://dz/oasis.mp3' }),
      ],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('APPLE: the equivalent two-row shape refuses rather than mis-picking', async () => {
    // INVERTED 2026-09-30, and the Apple mirror of the case above.
    // `searchApple` additionally takes -2000 for a mismatched artist, so the
    // right-artist row won the sort outright — and it was "Karma Police". The
    // old assertion (`previewUrl === 'https://a/radiohead.m4a'`) named that
    // mis-pick as the EXPECTED answer, so the asymmetry with the Deezer case was
    // pinned as intended rather than as a bug. Neither row here is the
    // requested recording — one has the wrong artist, the other the wrong title
    // — so null is the only honest answer.
    const { svc } = build({
      apple: [
        appleRow({ artistName: 'Oasis', previewUrl: 'https://a/oasis.m4a' }),
        appleRow({ trackName: 'Karma Police', collectionName: 'OK Computer', previewUrl: 'https://a/radiohead.m4a' }),
      ],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('a near-miss artist is still refused — "Radiohead Tribute Band" is not Radiohead', async () => {
    const { svc } = build({
      apple: [appleRow({ artistName: 'Radiohead Tribute Band', previewUrl: 'https://a/tribute.m4a' })],
    });

    await expect(svc.resolve('Suede', 'Creep')).resolves.toBeNull();
  });

  it('a wrong artist with NO track match at all is refused by the second discard, not the first', async () => {
    // The only shape that reaches the second `-1` return (line 179) rather than
    // the first (line 174). The first one fires when the artist is a genuine
    // mismatch; here the requested artist IS a substring of the row's artist
    // ("Blur" inside "Blur Band"), so the -2000 block is skipped entirely and
    // the row is left to be judged on its title alone. With no title overlap
    // there is nothing to save it, and it must be discarded rather than
    // returned as a match.
    const { svc } = build({
      apple: [appleRow({ artistName: 'Blur Band', trackName: 'Parklife', previewUrl: 'https://a/parklife.m4a' })],
    });

    await expect(svc.resolve('Blur', 'Song 2')).resolves.toBeNull();
  });

  it('a DIFFERENT act whose name merely EXTENDS the requested one is accepted — a known leniency', async () => {
    // The mirror of the test above, and it resolves rather than refusing. Both
    // `clean()` and `validateArtist` treat a name as a match when one contains
    // the other, so asking for "Blur" is satisfied by a row credited to
    // "Blur Band", and asking for a tribute act is satisfied by the act it
    // covers. Pinned as CHARACTERISATION, not endorsement: it is the same
    // substring rule that makes the guards work at all (see the "and" /
    // "Simon & Garfunkel" test), and it is looser than a user would want when
    // a row is a cover rather than the original. See BUG REPORT item 5.
    const { svc } = build({
      apple: [appleRow({ artistName: 'Blur Band', trackName: 'Song 2', previewUrl: 'https://a/blur-band.m4a' })],
    });

    const result = await svc.resolve('Blur', 'Song 2');

    expect(result?.artistName).toBe('Blur Band');
    expect(result?.trackName).toBe('Song 2');
  });

  it('a mismatched-artist row with a NEAR-MISS title is refused once an album hint lifts it', async () => {
    // The subtlest hole in the wrong-artist protection, and the reason it has
    // three separate discard rules rather than one.
    //
    // The scorer's artist comparison uses `clean()`, which deletes "&" and
    // leaves "and" behind, so "Simon & Garfunkel" and "Simon and Garfunkel"
    // look like different artists to it. The final `validateArtist` guard
    // normalises "&" to "and" and calls them the SAME. The two disagree, and
    // the album hint is large enough (+3500) to lift a row that the scorer
    // wanted to discard back above zero. Without the hint the row dies on the
    // -2000 penalty; with it, the -1 discard at the artist check is the ONLY
    // thing that saves it.
    const { svc } = build({
      apple: [{
        trackName: 'The Sound of Silence (Remastered)',
        artistName: 'Simon and Garfunkel',
        collectionName: 'Sounds of the Sixties',
        previewUrl: 'https://a/sg.m4a',
      }],
    });

    await expect(svc.resolve('Simon & Garfunkel', 'The Sound of Silence', 'Sounds of the Sixties')).resolves.toBeNull();
  });

  it('the guard runs after the choice, so a wrong artist is refused even with a valid preview URL', async () => {
    // The returned row has everything a user could want — name, album, a live
    // preview URL — and is still refused. Asserting on the URL specifically
    // keeps a future "but it had a preview" special case from creeping in.
    const { svc } = build({
      apple: [appleRow({ artistName: 'Oasis', previewUrl: 'https://a/very-real-preview.m4a' })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result).toBeNull();
    expect(result?.previewUrl).toBeUndefined();
  });
});

// ── 3b. THE WRONG-TRACK GUARD (added 2026-09-30) ────────────────────────────
//
// `validateArtist` used to be the only guard on the chosen row, and the scorer's
// -1000 wrong-title penalty cannot push a row below zero, so a right-artist
// / WRONG-track candidate won and was returned. The full mechanism is in BUG 1
// at the bottom of this file; what matters here is that the guard is pinned in
// BOTH directions, because a guard that refuses everything is not a fix.

describe('scoring — a right-artist candidate is only returned if it is the right TRACK', () => {
  it('APPLE: a right-artist / wrong-track candidate is refused, not returned with a live preview', async () => {
    // THE defect, in the exact shape it shipped in. One row, right artist, wrong
    // song, real preview URL. Before the fix this resolved to
    // `{ trackName: 'Karma Police', previewUrl: 'https://a/karma.m4a' }` and the
    // card rendered a button that played the wrong recording.
    const { svc } = build({
      apple: [appleRow({ trackName: 'Karma Police', collectionName: 'OK Computer', previewUrl: 'https://a/karma.m4a' })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result).toBeNull();
    expect(result?.previewUrl).toBeUndefined();
  });

  it('DEEZER: the same shape is refused there too', async () => {
    const { svc } = build({
      apple: null,
      deezer: [deezerRow({ id: 1, title: 'Karma Police', album: { id: 2, title: 'OK Computer' }, preview: 'https://dz/karma.mp3' })],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('APPLE: a refused wrong-track row is not cached as an answer', async () => {
    // A1. A wrong answer cached for an hour is an hour of wrong buttons; the
    // resolver must write nothing when it refuses.
    const { svc, set } = build({
      apple: [appleRow({ trackName: 'Karma Police', collectionName: 'OK Computer', previewUrl: 'https://a/karma.m4a' })],
    });

    await svc.resolve('Radiohead', 'Creep');

    expect(set).not.toHaveBeenCalled();
  });

  it('BOTH DIRECTIONS: adding the right-track row restores the resolution', async () => {
    // The counterpart to the two above. Without it a guard that returned null
    // unconditionally would be green on everything so far. Ordering is the
    // hostile one: the wrong-track row is listed FIRST, so a scorer that simply
    // took `valid[0]` would still return Karma Police here.
    const apple = build({
      apple: [
        appleRow({ trackName: 'Karma Police', collectionName: 'OK Computer', previewUrl: 'https://a/karma.m4a' }),
        appleRow({ collectionName: 'Pablo Honey', previewUrl: 'https://a/creep.m4a' }),
      ],
    });
    const deezer = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, title: 'Karma Police', album: { id: 2, title: 'OK Computer' }, preview: 'https://dz/karma.mp3' }),
        deezerRow({ id: 2, album: { id: 7, title: 'Pablo Honey' }, preview: 'https://dz/creep.mp3' }),
      ],
    });

    const a = await apple.svc.resolve('Radiohead', 'Creep');
    const d = await deezer.svc.resolve('Radiohead', 'Creep');

    expect(a?.trackName).toBe('Creep');
    expect(a?.previewUrl).toBe('https://a/creep.m4a');
    expect(d?.trackName).toBe('Creep');
    expect(d?.previewUrl).toBe('https://dz/creep.mp3');
  });

  it('a strict title match, not a substring: "Song" does not answer for "Song 2"', async () => {
    // The single most important property of the reused predicate. A loose guard
    // would accept "Song 2" for a request for "Song", which is the SAME
    // mis-attribution with a smaller distance between the two songs.
    const { svc } = build({
      apple: [appleRow({ trackName: 'Song 2', collectionName: 'Whatever', previewUrl: 'https://a/song2.m4a' })],
    });

    await expect(svc.resolve('Blur', 'Song')).resolves.toBeNull();
  });

  it('an album-hint +3500 cannot lift a wrong-track row over the guard', async () => {
    // The album bonus is large enough to outrank a correct row, so the guard has
    // to sit AFTER the sort, not inside the scoring. This is the shape that
    // made the Apple two-row test above resolve to Karma Police.
    const { svc } = build({
      apple: [appleRow({ trackName: 'Karma Police', collectionName: 'Pablo Honey', previewUrl: 'https://a/karma.m4a' })],
    });

    await expect(svc.resolve('Radiohead', 'Creep', 'Pablo Honey')).resolves.toBeNull();
  });

  it('a different RECORDING of the same title is refused — "Creep (Remix)" is not "Creep"', async () => {
    // The one place a containment is genuinely desirable, and the guard is not
    // it. A remix carries different audio, so serving it for the plain title
    // plays something the user did not ask to hear. Free behaviour of the reused
    // predicate; pinned here so nobody loosens it later.
    const { svc } = build({
      apple: [appleRow({ trackName: 'Creep (Remix)', collectionName: 'Pablo Honey', previewUrl: 'https://a/remix.m4a' })],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('a REMASTER of the requested title is still accepted — same recording', async () => {
    // The mirror of the test above, and the reason the reused predicate carries
    // an edition-tag rule at all. Providers legitimately return only the
    // remastered row for a plain title; refusing it would lose the preview on
    // every remastered single in the catalogue.
    const { svc } = build({
      apple: [appleRow({ trackName: 'Creep (Remastered)', collectionName: 'Pablo Honey', previewUrl: 'https://a/remaster.m4a' })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.trackName).toBe('Creep (Remastered)');
    expect(result?.previewUrl).toBe('https://a/remaster.m4a');
  });

  it('a date-prefixed compilation rip of the right song is accepted', async () => {
    // Why the guard reuses `artworkService`'s predicate instead of growing a
    // local one: that predicate tolerates the leading release date that DJ-pool
    // and compilation rips carry, because for many singles the prefixed row is
    // the ONLY row a provider returns. A locally-written strict comparison would
    // have thrown this away and the preview would be gone.
    const { svc } = build({
      apple: [appleRow({ artistName: 'Mac DeMarco', trackName: '20191009 I Like Her', collectionName: 'Cottage Core', previewUrl: 'https://a/date.m4a' })],
    });

    const result = await svc.resolve('Mac DeMarco', 'I Like Her');

    expect(result?.trackName).toBe('20191009 I Like Her');
    expect(result?.previewUrl).toBe('https://a/date.m4a');
  });

  it('a date-prefixed DIFFERENT song is still refused', async () => {
    // The prefix strip is not a wildcard. Without this, "20191009 Some Other
    // Song" would be read as matching anything on the same artist.
    const { svc } = build({
      apple: [appleRow({ artistName: 'Mac DeMarco', trackName: '20191009 Some Other Song', collectionName: 'Cottage Core', previewUrl: 'https://a/other.m4a' })],
    });

    await expect(svc.resolve('Mac DeMarco', 'I Like Her')).resolves.toBeNull();
  });

  it('a SPOTIFY rung preview for the wrong track is refused, and Apple still answers', async () => {
    // The Spotify rung is the FIRST thing `resolve` tries and it publishes
    // straight to the card, so a guard on the Apple/Deezer path alone would leave
    // the defect wide open. Its own internal guard is
    // `spotifyScraperService.isCloseMatch`, whose last line returns true for ANY
    // title once the artist matches, so the hole is real.
    const scraper = {
      getTrackPreview: vi.fn(async (..._a: unknown[]) => ({
        trackName: 'Karma Police', artistName: 'Radiohead', previewUrl: 'https://p.scdn.co/mp3-preview/karma',
      })),
      getPreviewById: vi.fn(async (..._a: unknown[]) => null),
    };
    const { svc } = build({ apple: [appleRow({ previewUrl: 'https://a/creep.m4a' })], deezer: [], scraper });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('apple');
    expect(result?.trackName).toBe('Creep');
    expect(result?.previewUrl).toBe('https://a/creep.m4a');
  });

  it('a SPOTIFY rung preview for the right track is still used', async () => {
    // The other direction on the same rung, so the test above cannot be passed
    // by refusing everything Spotify returns.
    const scraper = {
      getTrackPreview: vi.fn(async (..._a: unknown[]) => ({
        trackName: 'Creep', artistName: 'Radiohead', previewUrl: 'https://p.scdn.co/mp3-preview/creep',
      })),
      getPreviewById: vi.fn(async (..._a: unknown[]) => null),
    };
    const { svc } = build({ apple: [], deezer: [], scraper });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('spotify');
    expect(result?.previewUrl).toBe('https://p.scdn.co/mp3-preview/creep');
  });

  it('CHARACTERISATION: a row carrying NO title at all is still accepted', async () => {
    // A decision, not an endorsement, and it is the deliberate mirror of
    // `validateArtist` (which also accepts an absent artist, because the empty
    // string is a substring of everything — see BUG 2). The provider told us
    // nothing about the title, so there is no evidence of a mismatch; the
    // mapping substitutes the requested name. The stricter alternative (refuse
    // it) was considered and rejected because it would delete two long-standing
    // mapping fallbacks and buy nothing: a title-less row is rare, and where it
    // happens the artist still had to pass its own guard. Flipping this test to
    // a refusal is a product decision, not a bug fix.
    const { svc } = build({
      apple: [appleRow({ trackName: undefined, previewUrl: 'https://a/untitled.m4a' })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.trackName).toBe('Creep');
    expect(result?.previewUrl).toBe('https://a/untitled.m4a');
  });
});

// ── 4. An empty preview never throws; the resolver falls through ────────────

describe('rung fall-through — an empty preview is a miss, not a crash', () => {
  it('APPLE: a matched row with no previewUrl borrows the Deezer URL and keeps the Apple result', async () => {
    // The shape is why `previewUrl` is nullable end to end: a large share of
    // iTunes rows are preview-less or region-locked, so this is the NORMAL
    // case, not an edge case. The result stays attributed to Apple.
    const { svc } = build({
      apple: [appleRow({ previewUrl: null })],
      deezer: [deezerRow({ id: 3, preview: 'https://dz/fill.mp3' })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result).not.toBeNull();
    expect(result?.source).toBe('apple');
    expect(result?.previewUrl).toBe('https://dz/fill.mp3');
  });

  it('APPLE: a row missing the previewUrl key entirely behaves the same as an explicit null', async () => {
    const { svc } = build({
      apple: [appleRow({ previewUrl: undefined })],
      deezer: [deezerRow({ id: 3, preview: 'https://dz/fill.mp3' })],
    });

    expect((await svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://dz/fill.mp3');
  });

  it('DEEZER: a preview-less Deezer row falls back to a second Apple search', async () => {
    // The cross-provider rung at line 132: the Deezer row resolved the METADATA
    // but has no audio, so `resolve` goes back to Apple using the names Deezer
    // just supplied. The Apple search therefore runs twice.
    let appleCalls = 0;
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      {
        searchSongs: vi.fn(async (..._a: unknown[]) => {
          appleCalls += 1;
          return appleCalls === 1 ? [] : [appleRow({ previewUrl: 'https://a/second.m4a' })];
        }),
      } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => [deezerRow({ id: 6, preview: null, link: 'https://dz/6' })]) } as unknown as DeezerApi,
      cache,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(appleCalls).toBe(2);
    // Still attributed to Deezer: the fallback supplies the AUDIO, and the
    // store URL stays the Deezer track link that was already resolved.
    expect(result?.source).toBe('deezer');
    expect(result?.previewUrl).toBe('https://a/second.m4a');
  });

  it('no rung yields a previewUrl: the result is still returned, with previewUrl null', async () => {
    // An unresolved preview is an absence the card can render, and NOT a crash
    // and NOT a null that would read as "this track has no preview anywhere".
    const { svc } = build({ apple: [appleRow({ previewUrl: null })], deezer: [] });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result).not.toBeNull();
    expect(result?.source).toBe('apple');
    expect(result?.previewUrl).toBeNull();
    expect(result?.trackName).toBe('Creep');
  });

  it('an empty-preview row plus a throwing Deezer still returns the Apple row', async () => {
    // The Apple metadata survives the Deezer rung failing, because the failure
    // is contained in `searchDeezer`'s own try/catch. The preview stays null:
    // a rung failing is a rung failing, not the track losing its metadata.
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async (..._a: unknown[]) => [appleRow({ previewUrl: null })]) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => { throw new Error('deezer 500'); }) } as unknown as DeezerApi,
      cache,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('apple');
    expect(result?.trackName).toBe('Creep');
    expect(result?.previewUrl).toBeNull();
  });
});

// ── 4b. Spotify as the audio donor for a preview-less Apple/Deezer row ───────

describe('cross-provider — Spotify supplies the audio when the metadata row has none', () => {
  it('an Apple row with no previewUrl is filled from a second Spotify lookup', async () => {
    // The Spotify scraper is consulted twice, and the two calls mean different
    // things: the FIRST is the top-of-resolve rung (line 76), which misses
    // here so the Apple row is allowed to win on metadata. The SECOND is the
    // cross-provider donor (line 116), which asks for audio using the names
    // Apple just supplied. The result stays attributed to Apple: Spotify
    // contributed the audio, not the identity.
    let calls = 0;
    const scraper = {
      getTrackPreview: vi.fn(async (..._a: unknown[]) => {
        calls += 1;
        return calls === 1
          ? null
          : { trackName: 'Creep', artistName: 'Radiohead', previewUrl: 'https://p.scdn.co/mp3-preview/second.mp3', spotifyUrl: 'https://open.spotify.com/track/zz' };
      }),
      getPreviewById: vi.fn(async (..._a: unknown[]) => null),
    };
    const { svc } = build({ apple: [appleRow({ previewUrl: null })], deezer: [], scraper });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(calls).toBe(2);
    expect(result?.source).toBe('apple');
    expect(result?.previewUrl).toBe('https://p.scdn.co/mp3-preview/second.mp3');
    // The Apple store URL SURVIVES the Spotify donation. Line 124 only fills
    // `storeUrl` when it is still null, so a row that already links to an Apple
    // store page is not silently re-pointed at Spotify. The user clicked a
    // track on one service and the link should keep leading there.
    expect(result?.storeUrl).toBe('https://music.apple.com/us/album/creep/123');
  });

  it('a Spotify-donated preview supplies the store link when the metadata row had none', async () => {
    // The other side of the same `if (!result.storeUrl)` guard: a row with no
    // `trackViewUrl` at all, where the Spotify track link is the only link
    // there is. Without this the preview button would exist and lead nowhere.
    let calls = 0;
    const scraper = {
      getTrackPreview: vi.fn(async (..._a: unknown[]) => {
        calls += 1;
        return calls === 1
          ? null
          : { trackName: 'Creep', artistName: 'Radiohead', previewUrl: 'https://p.scdn.co/mp3-preview/second.mp3', spotifyUrl: 'https://open.spotify.com/track/zz' };
      }),
      getPreviewById: vi.fn(async (..._a: unknown[]) => null),
    };
    const { svc } = build({
      apple: [appleRow({ previewUrl: null, trackViewUrl: undefined })],
      deezer: [],
      scraper,
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.previewUrl).toBe('https://p.scdn.co/mp3-preview/second.mp3');
    expect(result?.storeUrl).toBe('https://open.spotify.com/track/zz');
  });

  it('when the direct Spotify lookup misses, the scraper is retried by track id', async () => {
    // The second chance at enrichment: resolve the Spotify track id from a
    // search URL and look the preview up by id. `spotifyApi` is the 5th
    // constructor parameter and is optional, so the double supplies exactly the
    // two methods the code calls.
    const getTrackPreview = vi.fn(async (..._a: unknown[]) => null);
    const getPreviewById = vi.fn(async (..._a: unknown[]) => ({
      trackName: 'Creep', artistName: 'Radiohead', previewUrl: 'https://p.scdn.co/mp3-preview/by-id.mp3',
    }));
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async (..._a: unknown[]) => [appleRow({ previewUrl: null })]) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => []) } as unknown as DeezerApi,
      cache,
      { getTrackPreview, getPreviewById } as never,
      { getSpotifyTrackUrl: vi.fn(async (..._a: unknown[]) => 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC') } as never,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    // The id is pulled out of the URL, which is the whole point of the retry:
    // a bare search URL with no id must not produce a lookup.
    expect(getPreviewById).toHaveBeenCalledTimes(1);
    expect(getPreviewById.mock.calls[0]?.[0]).toBe('4uLU6hMCjMI75M1A2tKUQC');
    expect(result?.previewUrl).toBe('https://p.scdn.co/mp3-preview/by-id.mp3');
  });

  it('a Spotify search URL with no track id in it is not turned into a lookup', async () => {
    // The `idMatch?.[1]` guard. Without it, `getPreviewById(undefined)` would
    // be called and a scraper that trusts its input would ask Spotify for a
    // track called "undefined".
    const getPreviewById = vi.fn(async (..._a: unknown[]) => ({
      trackName: 'Creep', artistName: 'Radiohead', previewUrl: 'https://p.scdn.co/should-not-happen.mp3',
    }));
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async (..._a: unknown[]) => [appleRow({ previewUrl: null })]) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => []) } as unknown as DeezerApi,
      cache,
      { getTrackPreview: vi.fn(async (..._a: unknown[]) => null), getPreviewById } as never,
      { getSpotifyTrackUrl: vi.fn(async (..._a: unknown[]) => 'https://open.spotify.com/search/Radiohead%20Creep') } as never,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(getPreviewById).not.toHaveBeenCalled();
    expect(result?.previewUrl).toBeNull();
  });

  it('the Spotify rung throwing does not stop the Apple search from running', async () => {
    // The first rung is wrapped in its own try/catch (lines 75-108). A dead
    // scraper must cost one rung, not the whole resolution.
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async (..._a: unknown[]) => [appleRow()]) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => []) } as unknown as DeezerApi,
      cache,
      {
        getTrackPreview: vi.fn(async (..._a: unknown[]) => { throw new Error('scraper offline'); }),
        getPreviewById: vi.fn(async (..._a: unknown[]) => null),
      } as never,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('apple');
    expect(result?.previewUrl).toBe('https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a');
  });
});

// ── 5. Apple and Deezer agree on equivalent inputs ─────────────────────────

describe('parity — Apple and Deezer resolve equivalent inputs to the same track', () => {
  it('the same artist/title/album resolves to the same track on both providers', async () => {
    const apple = build({ apple: [appleRow({ collectionName: 'Pablo Honey', previewUrl: 'https://a/x.m4a' })] });
    const deezer = build({ apple: null, deezer: [deezerRow({ album: { id: 7, title: 'Pablo Honey' }, preview: 'https://dz/x.mp3' })] });

    const a = await apple.svc.resolve('Radiohead', 'Creep', 'Pablo Honey');
    const d = await deezer.svc.resolve('Radiohead', 'Creep', 'Pablo Honey');

    expect(a?.trackName).toBe('Creep');
    expect(d?.trackName).toBe('Creep');
    expect(a?.artistName).toBe('Radiohead');
    expect(d?.artistName).toBe('Radiohead');
    expect(a?.source).toBe('apple');
    expect(d?.source).toBe('deezer');
  });

  it('both providers pick the same row out of an identical candidate set', async () => {
    // The candidate sets are the same tracks, same order, same relative
    // quality. Only the preview host differs. If the two scorers disagreed
    // about which row is correct, these would diverge.
    const apple = build({
      apple: [
        appleRow({ trackName: 'Creep (Remastered 2016)', previewUrl: 'https://a/partial.m4a' }),
        appleRow({ previewUrl: 'https://a/exact.m4a' }),
      ],
    });
    const deezer = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, title: 'Creep (Remastered 2016)', preview: 'https://dz/partial.mp3' }),
        deezerRow({ id: 2, preview: 'https://dz/exact.mp3' }),
      ],
    });

    const a = await apple.svc.resolve('Radiohead', 'Creep');
    const d = await deezer.svc.resolve('Radiohead', 'Creep');

    expect(a?.trackName).toBe(d?.trackName);
    expect(a?.trackName).toBe('Creep');
    expect(a?.previewUrl).toBe('https://a/exact.m4a');
    expect(d?.previewUrl).toBe('https://dz/exact.mp3');
  });

  it('both providers refuse the same wrong-artist candidate', async () => {
    const apple = build({ apple: [appleRow({ artistName: 'Oasis', previewUrl: 'https://a/oasis.m4a' })] });
    const deezer = build({ apple: null, deezer: [deezerRow({ id: 1, artist: { id: 9, name: 'Oasis' }, preview: 'https://dz/oasis.mp3' })] });

    await expect(apple.svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
    await expect(deezer.svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('both providers resolve the same album-hinted winner', async () => {
    const apple = build({
      apple: [
        appleRow({ collectionName: 'Kid A', previewUrl: 'https://a/kid-a.m4a' }),
        appleRow({ collectionName: 'Pablo Honey', previewUrl: 'https://a/pablo.m4a' }),
      ],
    });
    const deezer = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, album: { id: 1, title: 'Kid A' }, preview: 'https://dz/kid-a.mp3' }),
        deezerRow({ id: 2, album: { id: 2, title: 'Pablo Honey' }, preview: 'https://dz/pablo.mp3' }),
      ],
    });

    expect((await apple.svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.albumName).toBe('Pablo Honey');
    expect((await deezer.svc.resolve('Radiohead', 'Creep', 'Pablo Honey'))?.albumName).toBe('Pablo Honey');
  });
});

// ── 6. Nothing usable: a clean null, never a crash ─────────────────────────

describe('scoring — every candidate below zero yields a clean null', () => {
  it('APPLE: all candidates discarded returns null', async () => {
    const { svc } = build({
      apple: [
        appleRow({ artistName: 'Oasis' }),
        appleRow({ artistName: 'Blur' }),
        appleRow({ artistName: 'The Verve' }),
      ],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('DEEZER: all candidates discarded returns null', async () => {
    const { svc } = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, title: 'Song 2', artist: { id: 1, name: 'Blur' } }),
        deezerRow({ id: 2, title: 'Song 2', artist: { id: 2, name: 'Oasis' } }),
      ],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('both providers discarding everything returns null, not a throw', async () => {
    const { svc } = build({
      apple: [appleRow({ artistName: 'Oasis' })],
      deezer: [deezerRow({ id: 1, title: 'Something Else Entirely', artist: { id: 3, name: 'Blur' } })],
    });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('an empty result array from either provider is null', async () => {
    const { svc } = build({ apple: [], deezer: [] });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('a provider returning a null payload is null, not a TypeError', async () => {
    // `searchSongs` is typed `ITunesSearchResult[]`, so `null` is off-contract,
    // but the call site guards it and the resolver must not turn a provider
    // hiccup into a thrown error for the voice-message path.
    const { svc } = build({ apple: null, deezer: null });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('a throwing Apple search falls through to Deezer rather than propagating', async () => {
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async (..._a: unknown[]) => { throw new Error('itunes 503'); }) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => [deezerRow({ id: 8, preview: 'https://dz/fallback.mp3' })]) } as unknown as DeezerApi,
      cache,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('deezer');
    expect(result?.previewUrl).toBe('https://dz/fallback.mp3');
  });

  it('both providers throwing returns null', async () => {
    const cache = { get: vi.fn(async (..._a: unknown[]) => null), set: vi.fn(async (..._a: unknown[]) => undefined) } as unknown as CacheService;
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async (..._a: unknown[]) => { throw new Error('itunes 503'); }) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async (..._a: unknown[]) => { throw new Error('deezer 500'); }) } as unknown as DeezerApi,
      cache,
    );

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('nothing resolved means nothing cached', async () => {
    // The cache must not record a null: doing so would make the absence
    // permanent for the full TTL. (The TTL file covers the values; this covers
    // the decision not to write at all.)
    const { svc, set } = build({ apple: [appleRow({ artistName: 'Oasis' })], deezer: [] });

    await svc.resolve('Radiohead', 'Creep');

    expect(set).not.toHaveBeenCalled();
  });
});

// ── 7. Ordering, index bonus, and the artist-name special case ──────────────

describe('scoring — ordering and the remaining scorer rules', () => {
  it('identical candidates are separated by position: the first row wins', async () => {
    // Two byte-identical rows — nothing but the index bonus can choose. NOTE on
    // what this does and does not prove: `Array.prototype.sort` has been stable
    // since ES2019, so the first row wins a true tie whether or not the
    // `(15 - idx) * 10` term exists. Mutating that term away leaves this test
    // green, and no test in this file can catch it: every other scoring term is
    // a multiple of 100, so within the 5 rows `searchSongs` actually requests
    // the bonus can only ever spread rows 40 points apart, which is never
    // enough to flip an ordering the raw scores did not already decide. The
    // observable contract is what is asserted here; see BUG REPORT item 4.
    const { svc } = build({
      apple: [appleRow({ previewUrl: 'https://a/first.m4a' }), appleRow({ previewUrl: 'https://a/second.m4a' })],
    });

    expect((await svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://a/first.m4a');
  });

  it('a "baba" query refuses a non-baba candidate outright', async () => {
    // The scorer carries a hardcoded -5000 for this one artist string, which
    // exists because a well-known wrong-artist collision kept winning. Pinned
    // so the rule cannot be dropped silently.
    const { svc } = build({ apple: [appleRow({ artistName: 'Radiohead', previewUrl: 'https://a/radiohead.m4a' })] });

    await expect(svc.resolve('Baba Brinkman', 'Creep')).resolves.toBeNull();
  });

  it('a "baba" query still resolves when a baba row is present', async () => {
    const { svc } = build({
      apple: [
        appleRow({ artistName: 'Radiohead', previewUrl: 'https://a/radiohead.m4a' }),
        appleRow({ artistName: 'Baba Brinkman', previewUrl: 'https://a/baba.m4a' }),
      ],
    });

    expect((await svc.resolve('Baba Brinkman', 'Creep'))?.previewUrl).toBe('https://a/baba.m4a');
  });

  it('DEEZER: a wrong artist with NO track match is discarded by the scorer, not merely by the guard', async () => {
    // The Deezer mirror of the Apple case above, and it is load-bearing for a
    // different reason. `searchDeezer` has NO wrong-artist penalty at all, so
    // its only early rejection for a bad row is the no-track-match discard
    // (line 243). Delete it and this row — a different act, a different song,
    // an artist name that merely CONTAINS the requested one — sails through
    // scoring on the index bonus alone and then clears `validateArtist`,
    // because "Blur" is a substring of "Blur Band". The two guards are only
    // safe together; neither is sufficient on its own.
    const { svc } = build({
      apple: null,
      deezer: [deezerRow({ id: 1, title: 'Parklife', artist: { id: 1, name: 'Blur Band' }, album: { id: 1, title: 'The Great Escape' }, preview: 'https://dz/parklife.mp3' })],
    });

    await expect(svc.resolve('Blur', 'Song 2')).resolves.toBeNull();
  });

  it('the "baba" rule holds on Deezer too, in both directions', async () => {
    // `searchDeezer` carries its own copy of the rule (line 252), applied after
    // the album scoring rather than before it. Both halves are asserted because
    // they are separate lines in separate functions: the penalty is only
    // effective if it actually pushes the row below zero, and it is only safe
    // if the genuine row still outranks the penalty.
    const wrongOnly = build({
      apple: null,
      deezer: [deezerRow({ id: 1, artist: { id: 1, name: 'Radiohead' }, preview: 'https://dz/radiohead.mp3' })],
    });
    const both = build({
      apple: null,
      deezer: [
        deezerRow({ id: 1, artist: { id: 1, name: 'Radiohead' }, preview: 'https://dz/radiohead.mp3' }),
        deezerRow({ id: 2, artist: { id: 2, name: 'Baba Brinkman' }, preview: 'https://dz/baba.mp3' }),
      ],
    });

    await expect(wrongOnly.svc.resolve('Baba Brinkman', 'Creep')).resolves.toBeNull();
    expect((await both.svc.resolve('Baba Brinkman', 'Creep'))?.previewUrl).toBe('https://dz/baba.mp3');
  });

  it('the rule does not fire on an artist that merely contains the letters elsewhere', async () => {
    // The guard is `artist.toLowerCase().includes('baba')` — a substring test on
    // the REQUEST, not an equality test. An unrelated act is unaffected, so the
    // rule cannot be quietly swallowing normal queries.
    const { svc } = build({ apple: [appleRow({ artistName: 'Radiohead', previewUrl: 'https://a/radiohead.m4a' })] });

    expect((await svc.resolve('Radiohead', 'Creep'))?.previewUrl).toBe('https://a/radiohead.m4a');
  });

  it('an "&" / "and" difference in the artist is not a mismatch', async () => {
    // `validateArtist` normalises "&" to "and" before comparing, which the
    // `clean()` used by the scoring does not. A resolver that scored the
    // normalised form would resolve this; one that does not, still does,
    // because the final guard is the lenient one.
    const { svc } = build({ apple: [appleRow({ artistName: 'Simon and Garfunkel', trackName: 'The Sound of Silence' })] });

    expect((await svc.resolve('Simon & Garfunkel', 'The Sound of Silence'))?.artistName).toBe('Simon and Garfunkel');
  });

  it('the search is issued as (track, artist) — the order the iTunes API expects', async () => {
    const { svc, searchSongs } = build({ apple: [appleRow()] });

    await svc.resolve('Radiohead', 'Creep');

    expect(searchSongs).toHaveBeenCalledTimes(1);
    // Read with optional chaining: `noUncheckedIndexedAccess` makes calls[0][0]
    // `unknown | undefined`.
    expect(searchSongs.mock.calls[0]?.[0]).toBe('Creep');
    expect(searchSongs.mock.calls[0]?.[1]).toBe('Radiohead');
  });

  it('a cache hit short-circuits every provider call', async () => {
    const { svc, searchSongs, searchTracks } = build({
      apple: [appleRow()],
      deezer: [deezerRow()],
      cached: {
        trackName: 'Creep', artistName: 'Radiohead', albumName: 'Pablo Honey',
        durationMs: 239_000, previewUrl: 'https://cached/preview.m4a',
        storeUrl: null, artworkUrl: null, source: 'apple',
      },
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.previewUrl).toBe('https://cached/preview.m4a');
    expect(searchSongs).not.toHaveBeenCalled();
    expect(searchTracks).not.toHaveBeenCalled();
  });
});

// ── 8. Result mapping from the chosen row ──────────────────────────────────

describe('mapping — the chosen row is mapped onto ResolvedPreview', () => {
  it('APPLE: duration is milliseconds, artwork is upscaled, the store URL is kept', async () => {
    const { svc } = build({ apple: [appleRow()] });

    const result = await svc.resolve('Radiohead', 'Creep');

    // iTunes sends MILLISECONDS as a number. Wrapping this in Number() (as
    // every other count in this codebase needs) once hid a missing field.
    expect(result?.durationMs).toBe(239_000);
    expect(result?.artworkUrl).toBe('https://is1-ssl.mzstatic.com/image/thumb/abc600x600bb.jpg');
    expect(result?.storeUrl).toBe('https://music.apple.com/us/album/creep/123');
  });

  it('DEEZER: duration is seconds converted to ms, and a missing link falls back to the id', async () => {
    const { svc } = build({
      apple: null,
      deezer: [deezerRow({ id: 99, duration: 240, link: undefined, album: { id: 7, title: 'Pablo Honey', cover_big: 'https://cdn.example/big.jpg' } })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.durationMs).toBe(240_000);
    expect(result?.storeUrl).toBe('https://www.deezer.com/track/99');
    expect(result?.artworkUrl).toBe('https://cdn.example/big.jpg');
  });

  it('a missing duration maps to 0 on both providers, never NaN', async () => {
    const apple = build({ apple: [appleRow({ trackTimeMillis: undefined })] });
    const deezer = build({ apple: null, deezer: [deezerRow({ duration: undefined })] });

    expect((await apple.svc.resolve('Radiohead', 'Creep'))?.durationMs).toBe(0);
    // `Number(undefined ?? 0)` — the guard that keeps a NaN out of a progress
    // bar out of the mapping.
    expect((await deezer.svc.resolve('Radiohead', 'Creep'))?.durationMs).toBe(0);
  });

  it('a row missing its artist object does not throw', async () => {
    // A malformed Deezer row. It must degrade, not take the voice-message
    // path down with it.
    const { svc } = build({ apple: null, deezer: [{ id: 1, title: 'Creep' } as DeezerTrack] });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('deezer');
    expect(result?.trackName).toBe('Creep');
  });

  it('a row with NO title at all falls back to the requested track name', async () => {
    // The `?? track` on the mapping. A right-artist row with no title scores
    // -1000 rather than being discarded, so it can still be chosen — and when
    // it is, the result must not carry `trackName: undefined` to the card.
    // Substituting the REQUESTED name is the right call here: the row was
    // accepted as a match for that name, so echoing it keeps the card honest
    // about what was asked for.
    const { svc } = build({
      apple: null,
      deezer: [deezerRow({ id: 1, title: undefined, preview: 'https://dz/untitled.mp3' })],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.trackName).toBe('Creep');
    expect(result?.artistName).toBe('Radiohead');
  });

  it('a row missing its album maps to null, not undefined', async () => {
    // `albumName` is `string | null` in the contract, and the card branches on
    // it. An `undefined` leaking through would make `albumName` falsy but not
    // null, which is the kind of difference a `??` downstream silently eats.
    const { svc } = build({ apple: null, deezer: [deezerRow({ id: 1, album: undefined })] });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.albumName).toBeNull();
  });

  it('APPLE: an ABSENT artistName falls back to the requested artist — but an EMPTY one does not', async () => {
    // The `?? artist` on line 201, and the sharp edge of BUG 2 right beside it.
    // Two rows, both of which the scoring accepts (an artistless row scores
    // 2000 for the exact title, minus the 2000 wrong-artist penalty, which
    // lands it at +150 — still above zero), and both of which pass
    // `validateArtist` because the empty string is a substring of everything.
    // The difference is entirely in the `??`:
    //   undefined -> the REQUESTED artist is substituted
    //   ''        -> the empty string is passed straight through
    // A row the provider simply omitted its artist on and a row that sent an
    // empty one are the same absence, and they must not resolve differently.
    const absent = build({ apple: [appleRow({ artistName: undefined })] });
    const empty = build({ apple: [appleRow({ artistName: '' })] });

    const absentResult = await absent.svc.resolve('Radiohead', 'Creep');
    const emptyResult = await empty.svc.resolve('Radiohead', 'Creep');

    expect(absentResult?.artistName).toBe('Radiohead');
    // CHARACTERISATION of the bug, not an endorsement: this is what the card
    // would render today, with no artist at all.
    expect(emptyResult?.artistName).toBe('');
  });

  it('a row with no trackName falls back to the requested name, and no artwork maps to null', async () => {
    // Both `??`/`?:` fallbacks on the Apple mapping, in one fixture: a row with
    // neither a title nor artwork. Neither gap may reach the card as
    // `undefined` — `trackName` is what the embed header renders and
    // `artworkUrl` is what the image helper branches on.
    const { svc } = build({
      apple: [{
        artistName: 'Radiohead',
        previewUrl: 'https://a/bare.m4a',
        trackViewUrl: 'https://music.apple.com/us/album/bare/1',
      }],
    });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.trackName).toBe('Creep');
    expect(result?.artworkUrl).toBeNull();
    expect(result?.albumName).toBeNull();
  });

  it('DEEZER: a query carrying punctuation is still matched on the alphanumeric skeleton', async () => {
    // Covers the `querySymbols` bonus (line 245-247), which compares the
    // non-alphanumeric skeleton of the query against the same skeleton of the
    // result. It only ever fires for a query made of punctuation, because the
    // query side is NOT lowercased while the result side is — see the note
    // below and BUG REPORT item 6.
    const { svc } = build({
      apple: null,
      deezer: [deezerRow({ id: 1, title: 'c&d', artist: { id: 1, name: 'a&b' }, album: { id: 1, title: 'x&y' }, preview: 'https://dz/punct.mp3' })],
    });

    const result = await svc.resolve('a&b', 'c&d');

    expect(result?.artistName).toBe('a&b');
    expect(result?.trackName).toBe('c&d');
    expect(result?.previewUrl).toBe('https://dz/punct.mp3');
  });

  it('the result is cached under the artist|track key, in the rungs own order', async () => {
    const { svc, get, set } = build({ apple: [appleRow()] });

    await svc.resolve('Radiohead', 'Creep');

    // Both the read and the write must use the same key, or the resolver
    // re-searches on every call while the cache looks populated.
    expect(get.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
    expect(String(get.mock.calls[0]?.[0])).toContain('radiohead');
  });
});

/**
 * BUG REPORT — found while writing these tests.
 * BUG 1 is FIXED (2026-09-30); BUG 2-6 are NOT (out of scope, still true).
 * Line numbers are from the version read at the time of writing.
 *
 * ── BUG 1 (the serious one): FIXED — a right-artist / WRONG-TRACK candidate
 * used to be accepted and returned as the requested song.
 *   Lines 173-180 (searchApple) and 241-244 (searchDeezer) as they read here.
 *   When the track does not match at all, the candidate is penalised by
 *   -1000 (if the artist is right) rather than discarded, and -1000 is not
 *   enough to push it below zero on its own: +2000 for an exact artist and
 *   +1000 for the artist appearing in the row leaves it at +2000 net. So when
 *   a provider returns the right artist and the wrong track as its ONLY
 *   candidate, `resolve('Radiohead', 'Creep')` returned
 *   `{ trackName: 'Karma Police', ... }` — a confidently wrong song with a
 *   working preview button.
 *   The scoring rejects on score < 0 and the final guard checked only the
 *   ARTIST (`validateArtist`, lines 198 and 260). There was no equivalent
 *   `validateTrack` on the chosen row, so nothing caught it. Verified by
 *   running the real service: it returned the Karma Police row.
 *   Two tests in this file PINNED that behaviour, which is what made the fix
 *   auditable: the Deezer "same pair in the other order" test asserted
 *   `artistName === 'Radiohead'` on a Karma Police row, and the Apple two-row
 *   test asserted the Karma Police preview URL as the expected answer. Both are
 *   inverted above, and section 3b pins the guard in both directions.
 *   TWO SHAPES REMAIN, and neither is closed by this fix:
 *     (a) `spotifyScraperService.isCloseMatch` ends in `return cExpA === cActA`,
 *         so ITS guard accepts any title once the artist matches — and its unit
 *         test pins that leniency ("accepts when the artist matches and the
 *         title differs slightly"). The Spotify rung inside `resolve` is
 *         therefore guarded by `validateTrack` as well, but the scraper itself
 *         is still loose.
 *     (b) A row with no title at all is accepted, mirroring `validateArtist`'s
 *         treatment of an absent artist. Pinned as characterisation in 3b.
 *
 * ── BUG 2: an empty `artistName` passes the artist guard.
 *   Line 60-66 (`validateArtist`) and line 201 (`artistName: chosen.artistName ?? artist`).
 *   `validateArtist('Radiohead', '')` returns TRUE, because `e.includes(a)`
 *   is trivially true for the empty string and `e.length > 3` passes. The
 *   `??` on line 201 also does not fire, because `''` is not nullish. So an
 *   Apple row with `artistName: ''` resolves to
 *   `{ artistName: '' }` — the requested artist is dropped entirely rather
 *   than substituted. Verified by running the real service: artistName is
 *   the empty string. A `|| artist` instead of `?? artist`, or an explicit
 *   empty check in `validateArtist`, would close it.
 *
 * ── BUG 3 (minor, by design or otherwise — flagging, not claiming): the
 * `validateArtist` guard is all-or-nothing. It refuses the chosen row and
 * the whole resolution becomes null rather than dropping that row and
 * re-picking the runner-up, so a perfectly good candidate at index 1 is
 * discarded with the bad one at index 0. This is visible in the Deezer
 * out-scoring test above. Arguably correct — a refusal is safer than a
 * guess — but it means a single high-scoring bad row can blank an otherwise
 * good result set.
 *
 * ── BUG 4 (dead logic, harmless): the index tie-break is inert.
 * Line 189, `score += (15 - idx) * 10`. Mutation-checked: deleting the term
 * leaves all 50 tests in this file green, and no test can catch it. Every
 * other scoring term is a multiple of 100, so within the 5 rows `searchSongs`
 * actually requests (its default `limit`), the bonus can only spread rows 40
 * points apart — never enough to flip an ordering the raw scores did not
 * already settle. It mattered only before ES2019, when `Array.prototype.sort`
 * was not guaranteed stable and an unstable sort could reorder true ties.
 * Keeping it is defensible as a cheap guarantee that provider order breaks
 * ties; removing it would be equally correct. Flagged so nobody later "fixes"
 * the tie-break by tuning a number that does nothing.
 *
 * ── BUG 5 (accepted risk, flagged so it is a decision and not an accident):
 * the artist guards match on SUBSTRING in both directions. Asking for "Blur"
 * is satisfied by a row credited to "Blur Band"; asking for an act is
 * satisfied by a tribute act carrying its name. This is load-bearing for
 * "Simon & Garfunkel" / "Simon and Garfunkel" and for features, so it cannot
 * simply be tightened to equality — but it means a cover is reported as the
 * original. A test pins the current behaviour as characterisation; tightening
 * it is a product decision, not a bug fix.
 *
 * ── BUG 6 (dead logic from a case-folding slip): the symbol bonus can never
 * fire for a real query. Lines 186-188 (searchApple) and 245-247 (searchDeezer)
 * both do:
 *     const querySymbols = (artist + track).replace(/[a-z0-9\s]/g, '');
 *     const resSymbols  = (resArt + resTrack + resColl).replace(/[a-z0-9\s]/g, '');
 *     if (querySymbols && resSymbols.includes(querySymbols)) score += 800;
 * `resArt` / `resTrack` / `resColl` were lowercased a few lines earlier, so
 * `resSymbols` is always lowercase — but `artist` and `track` are the raw
 * arguments, so `querySymbols` keeps every capital letter. "Radiohead Creep"
 * yields "RC", which can never appear in a lowercased string, and an all-lowercase
 * query yields "" which is falsy and short-circuits. The branch therefore fires
 * only when the query is made of punctuation with no letters at all, e.g.
 * "a&b" -> "&&". The intent was plainly to compare the two sides' punctuation
 * skeletons; lowercasing the query (or reusing the `clean` helpers) would do it.
 * Harmless today — the bonus is 800 and the alphabet-based scoring already
 * carries the decision — but +800 is currently a constant zero. A test covers
 * the reachable punctuation case so the branch is not deleted as unreachable
 * without someone noticing why it stopped mattering.
 *
 * ── MUTATION RECORD (11 mutants, run against a COPY of the service) ──
 * Caught:    both `validateArtist` guards, the ascending-sort flip (13
 *            failures), the partial album tier, the -1000 wrong-title
 *            penalty, the swapped `(track, artist)` search args, and the
 *            cross-provider fill-in.
 * Survived:  `score >= 0` → `score > 0` and the index bonus. Both are
 *            EQUIVALENT mutants rather than test gaps — a candidate cannot
 *            reach exactly 0 within 5 rows, and the index term cannot change
 *            an outcome (see BUG 4). Two further mutants (exact album tier,
 *            the -1 artist discard) initially survived and were then killed
 *            by the two fixtures added in response; they are recorded in the
 *            comments on those tests.
 */
