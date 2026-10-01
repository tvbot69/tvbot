import { container } from 'tsyringe';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { ArtistsService } from '@bot/services/library/artistsService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { DeezerApi } from '@deezer/api/deezerApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

/**
 * Everything the top-list builders need, passed in rather than reached for.
 *
 * Same shape and same reasoning as `whoKnowsImageDeps.ts`, which was extracted
 * from the WhoKnows image builder for the same reason: `topBuilders.ts` reached
 * into the service locator eleven times, which meant its tests had to mutate the
 * global container to get a collaborator in place.
 *
 * Every field is nullable because every one of those call sites was already
 * guarded with `isRegistered`. Those guards are preserved exactly: a service
 * that is not registered becomes `null` and its branch is skipped, which is the
 * behaviour the bot already had.
 *
 * `resolveTopBuildersDeps` is the only place here that reads the container.
 */
export interface TopBuildersDeps {
  generator: WhoKnowsGenerator | null;
  artistsService: ArtistsService | null;
  artworkService: ArtworkService | null;
  deezerApi: DeezerApi | null;
  lastfmRepo: LastFmRepository | null;
  spotifyApi: SpotifySearchApi | null;
}

export const resolveTopBuildersDeps = (): TopBuildersDeps => {
  const pick = <T>(token: new (...args: never[]) => T): T | null =>
    container.isRegistered(token as never) ? (container.resolve(token as never) as T) : null;

  return {
    generator: pick<WhoKnowsGenerator>(WhoKnowsGenerator),
    artistsService: pick<ArtistsService>(ArtistsService),
    artworkService: pick<ArtworkService>(ArtworkService),
    deezerApi: pick<DeezerApi>(DeezerApi),
    lastfmRepo: pick<LastFmRepository>(LastFmRepository),
    spotifyApi: pick<SpotifySearchApi>(SpotifySearchApi),
  };
};
