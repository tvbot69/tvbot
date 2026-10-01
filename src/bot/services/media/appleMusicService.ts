import { injectable } from 'tsyringe';
import { AppleMusicSearchApi, upscaleArtwork } from '@applemusic/api/appleMusicSearchApi';

export interface AppleMusicItem {
  trackName: string;
  artistName: string;
  albumName?: string;
  url: string;
  artworkUrl?: string;
}

/**
 * The three Apple Music link lookups, as the command layer wants them.
 *
 * THIS CLASS USED TO CONTAIN THREE HAND-ROLLED iTunes SEARCH CLIENTS - one
 * `fetch` per method, each building its own URL against
 * `https://itunes.apple.com/search` (`appleMusicService.ts:16`, `:43`, `:62` at
 * the time of writing). All three ended with the same pair of lines:
 *
 *     if (!response.ok) return null;      // line 22 / 49 / 68
 *     } catch (err) { ... return null; }  // line 37 / 56 / 75
 *
 * That is the project's stated worst failure mode. A transient 503 from
 * iTunes.apple.com produced `null`, which the caller read as "Apple has no
 * release by that name", and the user was told a catalogue fact that nobody had
 * checked. The second iTunes Search client already in the repo -
 * `AppleMusicSearchApi`, used by `artworkService` and `previewResolverService` -
 * raised instead, correctly. So the bot had one client that knew the
 * difference and three that did not, all hitting the same anonymous endpoint
 * with the same query parameters.
 *
 * All three are deleted. There is now ONE iTunes Search request in the bot, and
 * `AppleMusicSearchApi.search` is the only place that knows how to tell a
 * failed read from an empty one.
 *
 * THE CONTRACT, AND WHY IT IS THIS WAY
 * ------------------------------------
 * `null` means GENUINE NO MATCH, and only that. A 503, a 500, a DNS failure or
 * a timeout RAISES `ITunesUnavailableError`. The callers distinguish them by
 * rendering `Error` with the provider's message against `NotFound` - the shape
 * the Spotify commands beside them already use.
 *
 * The alternative - keeping a `catch` that logs and returns `null` - is the bug
 * this file used to be. A warning in the log is not a substitute for the user
 * being told the truth: the user reads the answer, not the log.
 *
 * The default argument on the constructor keeps `new AppleMusicService()` valid,
 * which is how `startup.ts` builds it, and is the same shape
 * `AppleMusicResolver` uses for its token scraper
 * (`services/music/appleMusicResolver.ts:47`).
 */
@injectable()
export class AppleMusicService {
  constructor(private readonly searchApi: AppleMusicSearchApi = new AppleMusicSearchApi()) {}

  public async searchSong(query: string): Promise<AppleMusicItem | null> {
    const [track] = await this.searchApi.searchSongs(query, undefined, 1);
    if (!track) return null;

    return {
      trackName: track.trackName ?? '',
      artistName: track.artistName ?? '',
      albumName: track.collectionName ?? '',
      url: track.trackViewUrl ?? '',
      artworkUrl: track.artworkUrl100 ? upscaleArtwork(track.artworkUrl100, 600) : undefined,
    };
  }

  public async searchAlbum(query: string): Promise<string | null> {
    const [album] = await this.searchApi.searchAlbums(query, undefined, 1);
    return album?.collectionViewUrl ?? null;
  }

  public async searchArtist(query: string): Promise<string | null> {
    const [artist] = await this.searchApi.searchArtists(query, 1);
    return artist?.artistLinkUrl ?? null;
  }
}