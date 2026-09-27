import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { DeezerCoverIndexer } from './deezerCoverIndexer';
import type { DeezerAlbum } from '@deezer/models/deezerModels';

/**
 * The write path this module was extracted to own.
 *
 * Before extraction this ran inside a `setImmediate` in a response builder,
 * behind a dynamic import and an `isRegistered` guard, and any failure was
 * swallowed at DEBUG with no artist name attached. So it had no tests and could
 * not have had any: a presentation factory with write access to the data layer
 * cannot be tested with plain mocks.
 *
 * The behaviours worth pinning are the ones that cost data if they regress:
 *   - an album that already has a Deezer cover is NOT overwritten, because
 *     these rows are cached forever, so a scraped cover replacing a good one is
 *     a permanent downgrade
 *   - the largest cover available is preferred, in xl -> big -> medium order
 *   - a failure never escapes, because the response has already been sent
 */

const album = (over: Partial<DeezerAlbum> = {}): DeezerAlbum =>
  ({
    id: 555,
    title: 'OK Computer',
    cover_xl: 'https://img.test/xl.jpg',
    cover_big: 'https://img.test/big.jpg',
    cover_medium: 'https://img.test/medium.jpg',
    ...over,
  }) as DeezerAlbum;

const harness = (existing?: { deezerImageUrl?: string | null }) => {
  const getOrCreateArtist = vi.fn(async () => ({ artistId: 7 }));
  const getOrCreateAlbum = vi.fn(async () => ({ albumId: 42, deezerImageUrl: existing?.deezerImageUrl }));
  const setDeezerImage = vi.fn(async () => undefined);

  const indexer = new DeezerCoverIndexer(
    { getOrCreateArtist } as never,
    { getOrCreateAlbum, setDeezerImage } as never,
  );
  return { indexer, getOrCreateArtist, getOrCreateAlbum, setDeezerImage };
};

describe('DeezerCoverIndexer', () => {
  it('writes a cover for an album that has none', async () => {
    const { indexer, getOrCreateArtist, getOrCreateAlbum, setDeezerImage } = harness({ deezerImageUrl: null });

    const written = await indexer.indexCovers('Radiohead', [album()]);

    expect(written).toBe(1);
    expect(getOrCreateArtist).toHaveBeenCalledWith('Radiohead');
    expect(getOrCreateAlbum).toHaveBeenCalledWith('OK Computer', 7, 'https://img.test/xl.jpg');
    expect(setDeezerImage).toHaveBeenCalledWith(42, 555, 'https://img.test/xl.jpg');
  });

  it('never overwrites an album that already has a Deezer cover', async () => {
    // The regression that would cost data: these rows are cached indefinitely,
    // so replacing an existing cover with a scraped one cannot be undone.
    const { indexer, setDeezerImage } = harness({ deezerImageUrl: 'https://img.test/authoritative.jpg' });

    const written = await indexer.indexCovers('Radiohead', [album()]);

    expect(written).toBe(0);
    expect(setDeezerImage).not.toHaveBeenCalled();
  });

  it('prefers the largest available cover', async () => {
    const { indexer, setDeezerImage } = harness({ deezerImageUrl: null });

    await indexer.indexCovers('Radiohead', [album({ cover_xl: undefined })]);
    expect(setDeezerImage).toHaveBeenCalledWith(42, 555, 'https://img.test/big.jpg');

    const second = harness({ deezerImageUrl: null });
    await second.indexer.indexCovers('Radiohead', [
      album({ cover_xl: undefined, cover_big: undefined }),
    ]);
    expect(second.setDeezerImage).toHaveBeenCalledWith(
      42,
      555,
      'https://img.test/medium.jpg',
    );
  });

  it('skips albums with no usable cover or title', async () => {
    const { indexer, getOrCreateAlbum } = harness({ deezerImageUrl: null });

    const written = await indexer.indexCovers('Radiohead', [
      album({ cover_xl: undefined, cover_big: undefined, cover_medium: undefined }),
      album({ title: '' }),
    ]);

    expect(written).toBe(0);
    expect(getOrCreateAlbum).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty list or a blank artist', async () => {
    const { indexer, getOrCreateArtist } = harness();
    expect(await indexer.indexCovers('Radiohead', [])).toBe(0);
    expect(await indexer.indexCovers('', [album()])).toBe(0);
    expect(getOrCreateArtist).not.toHaveBeenCalled();
  });

  it('swallows a database failure rather than throwing at the caller', async () => {
    // The caller runs this after the response is already sent, so a rejection
    // has nowhere useful to go and would surface as an unhandled rejection.
    const artistRepo = {
      getOrCreateArtist: vi.fn(async () => {
        throw new Error('db is down');
      }),
    } as never;
    const indexer = new DeezerCoverIndexer(artistRepo, {} as never);

    await expect(indexer.indexCovers('Radiohead', [album()])).resolves.toBe(0);
  });

  it('aborts the batch when one album write throws', async () => {
    // Pins CURRENT behaviour, which is all-or-nothing: one try wraps the whole
    // loop, so a failure on the first album means the rest are never attempted.
    //
    // Per-album isolation would be better - one malformed row should not block
    // the other nine covers, and the whole point of this path is that they are
    // cached forever. It is a deliberate change rather than a bug fix, so it is
    // recorded here instead of being assumed. If someone makes that change, this
    // test is the thing that should fail and be rewritten.
    const { indexer, getOrCreateAlbum } = harness({ deezerImageUrl: null });
    (getOrCreateAlbum as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('constraint violation'),
    );

    const written = await indexer.indexCovers('Radiohead', [
      album({ id: 1, title: 'First' }),
      album({ id: 2, title: 'Second' }),
    ]);

    expect(written).toBe(0);
    expect(getOrCreateAlbum).toHaveBeenCalledTimes(1);
  });
});
