import type { LfmImage, RecentTrackLfm } from '@lastfm/models/recentTracksLfm';
import type { RecentTrack } from '@domain/models/recentTrack';

const LASTFM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';
const isPlaceholder = (url?: string): boolean => !!url && url.includes(LASTFM_PLACEHOLDER_HASH);

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
        : (track.artist as any)?.name ?? (track.artist as any)?.['#text'] ?? '';
    const artistMbid =
      typeof track.artist === 'string'
        ? undefined
        : track.artist.mbid || (track.artist as any)?.mbid || undefined;
    const albumName =
      typeof track.album === 'string'
        ? track.album
        : (track.album as any)?.name ?? (track.album as any)?.['#text'] ?? '';

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
