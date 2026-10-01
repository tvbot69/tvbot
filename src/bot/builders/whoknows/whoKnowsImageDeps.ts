import { container } from 'tsyringe';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { ArtistsService } from '@bot/services/library/artistsService';
import { AlbumService } from '@bot/services/library/albumService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { UserService } from '@bot/services/user/userService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/api/deezerApi';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import { DeezerCoverIndexer } from '@bot/services/media/deezerCoverIndexer';

/**
 * Every collaborator the WhoKnows image builder needs, passed in rather than
 * reached for.
 *
 * The shape of this module is the point. `buildWhoKnowsImageResponse` used to
 * call `container.isRegistered` and `container.resolve` nineteen times, with no
 * declared dependencies and no way to substitute a double - so its only test had
 * to mutate the global container, which is a real coupling, not a testing
 * inconvenience. Every field is nullable because every one of those call sites
 * was already guarded by `isRegistered`, and every guard is preserved here
 * exactly: an unregistered service becomes `null` and the corresponding branch
 * is skipped, which is the behaviour the bot already had in production and in
 * tests.
 *
 * `resolveWhoKnowsImageDeps` is the ONE place that reads the container, so the
 * remaining coupling is auditable in a single file instead of scattered through a
 * presentation factory. The builder itself is now a pure function of its
 * arguments.
 */
export interface WhoKnowsImageDeps {
  /** Absent means no image is produced at all, and the builder returns null. */
  generator: WhoKnowsGenerator | null;
  artistsService: ArtistsService | null;
  albumService: AlbumService | null;
  artworkService: ArtworkService | null;
  userService: UserService | null;
  spotifyApi: SpotifySearchApi | null;
  deezerApi: DeezerApi | null;
  /** Absent disables background cover indexing, exactly as the old guard did. */
  coverIndexer: DeezerCoverIndexer | null;
}

/**
 * Reads the container once and returns the builder's dependencies.
 *
 * Uses `isRegistered` rather than a try/catch around `resolve` because tsyringe
 * throws on an unregistered token, and the previous code depended on absence
 * being a supported state - a partially built container rendered a plainer card
 * rather than failing the command.
 */
export const resolveWhoKnowsImageDeps = (): WhoKnowsImageDeps => {
  const pick = <T>(token: new (...args: never[]) => T): T | null =>
    container.isRegistered(token as never) ? (container.resolve(token as never) as T) : null;

  return {
    generator: pick<WhoKnowsGenerator>(WhoKnowsGenerator),
    artistsService: pick<ArtistsService>(ArtistsService),
    albumService: pick<AlbumService>(AlbumService),
    artworkService: pick<ArtworkService>(ArtworkService),
    userService: pick<UserService>(UserService),
    spotifyApi: pick<SpotifySearchApi>(SpotifySearchApi),
    deezerApi: pick<DeezerApi>(DeezerApi),
    coverIndexer:
      container.isRegistered(ArtistRepository) && container.isRegistered(AlbumRepository)
        ? new DeezerCoverIndexer(
            container.resolve(ArtistRepository),
            container.resolve(AlbumRepository),
          )
        : null,
  };
};
