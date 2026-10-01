import type { LfmImage, RecentTrackLfm } from '@lastfm/models/recentTracksLfm';
import type { RecentTrack } from '@domain/models/recentTrack';
import { isPlaceholderImageUrl } from '@domain/lastfm/lastfmPlaceholder';

const isPlaceholder = (url?: string): boolean => !!url && isPlaceholderImageUrl(url);

/**
 * Last.fm sends `artist` and `album` either as a bare string or as an
 * object whose NAME LIVES UNDER `#text`. That hash-prefixed key is XML
 * residue from the original API, and a fixture written as `{ name }` passes
 * tests the real payload fails. Typed here so the shape is checked rather
 * than reached for with `as any`.
 */
interface NamedRef {
  name?: string;
  '#text'?: string;
  mbid?: string;
}
export class TrackConverter {
  public static pickLargestImage(images?: LfmImage[]): string | undefined {
    if (!images || images.length === 0) {
      return undefined;
    }
    const priority = ['mega', 'extralarge', 'large', 'medium', 'small'];
    for (const size of priority) {
      const match = images.find((i) => i.size === size && i['#text'] && !isPlaceholder(i['#text']));
      if (match) {
        return match['#text'];
      }
    }
    const fallback = images.find((i) => i['#text'] && !isPlaceholder(i['#text']))?.['#text'];
    return fallback;
  }

  public static convertRecentTrack(track: RecentTrackLfm): RecentTrack {
    const artistName =
      typeof track.artist === 'string'
        ? track.artist
        : (track.artist as NamedRef | undefined)?.name ?? (track.artist as NamedRef | undefined)?.['#text'] ?? '';
    const artistMbid =
      typeof track.artist === 'string'
        ? undefined
        : track.artist.mbid || (track.artist as NamedRef | undefined)?.mbid || undefined;
    const albumName =
      typeof track.album === 'string'
        ? track.album
        : (track.album as NamedRef | undefined)?.name ?? (track.album as NamedRef | undefined)?.['#text'] ?? '';

    return {
      name: track.name,
      artistName: artistName,
      albumName: albumName || '',
      artistMbid: artistMbid,
      albumMbid: undefined,
      trackMbid: track.mbid || undefined,
      imageUrl: this.pickLargestImage(track.image),
      nowPlaying: track['@attr']?.nowplaying === 'true',
      timePlayed: track.date?.uts ? new Date(Number(track.date.uts) * 1000) : undefined,
    };
  }
}
