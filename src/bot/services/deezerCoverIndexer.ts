import { Logger } from '@domain/logger';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import type { DeezerAlbum } from '@deezer/models/deezerModels';

/**
 * Writes discovered Deezer album covers back to the database.
 *
 * Extracted from `whoKnowsImageBuilder` on 2026-09-27, and the reason is worth
 * recording: a presentation factory was creating Artist and Album rows and
 * writing cover URLs, from inside a `setImmediate`, reached by a *dynamic*
 * import, wrapped in an `isRegistered` guard, and swallowed at DEBUG on failure.
 *
 * That combination is the worst kind of write path - it runs after the response
 * has already been sent, so a failure is invisible to the user, and the guard
 * meant the commonest cause (repositories not yet registered) failed silently.
 * The file's own docblock called it "a presentation factory with write access to
 * the data layer". It was right.
 *
 * Why it existed at all: the collage gathers covers faster than a user watches,
 * so throwing them away meant re-scraping forever. Indexing them is the right
 * behaviour. Doing it from a builder was the mistake.
 *
 * Still fire-and-forget by design, because a response must never wait on a
 * write. But now the failure is at DEBUG with the artist name attached, the
 * writes are the only thing this module does, and it is testable with two
 * repository doubles and no container.
 */
export class DeezerCoverIndexer {
  public constructor(
    private readonly artistRepo: ArtistRepository,
    private readonly albumRepo: AlbumRepository,
  ) {}

  /**
   * Best-effort indexing. Never throws: the caller has already replied by the
   * time this runs, so a raised error has nowhere useful to go.
   *
   * @param artistName artist the covers belong to
   * @param verifiedAlbums albums whose cover was actually matched to a track
   * @returns how many covers were newly written
   */
  public async indexCovers(
    artistName: string,
    verifiedAlbums: DeezerAlbum[],
  ): Promise<number> {
    if (verifiedAlbums.length === 0 || !artistName) return 0;

    let written = 0;
    try {
      const artist = await this.artistRepo.getOrCreateArtist(artistName);
      for (const da of verifiedAlbums) {
        const cover = da.cover_xl ?? da.cover_big ?? da.cover_medium;
        if (!cover || !da.title) continue;
        const alb = await this.albumRepo.getOrCreateAlbum(da.title, artist.artistId, cover);
        // Only write when the album has no Deezer cover yet: these are cached
        // forever, so overwriting a good one with a scraped one is a downgrade.
        if (!alb.deezerImageUrl) {
          await this.albumRepo.setDeezerImage(alb.albumId, da.id, cover);
          written++;
        }
      }
    } catch (err) {
      // Expected-but-notable: the collage still renders, we just lose the cache.
      Logger.debug({ err, artistName }, 'Background indexing of Deezer covers failed');
    }
    return written;
  }
}
