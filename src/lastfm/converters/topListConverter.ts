import type {
  TopAlbumsResponseLfm,
  TopArtistsResponseLfm,
  TopTracksResponseLfm,
  WeeklyAlbumChartResponseLfm,
  WeeklyArtistChartResponseLfm,
  WeeklyTrackChartResponseLfm,
} from '@lastfm/models/topListsLfm';
import type { LfmImage } from '@lastfm/models/recentTracksLfm';
import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import { TrackConverter } from './recentTrackConverter';

const extractArtistName = (
  artist:
    | {
        name?: string;
        '#text'?: string;
        mbid?: string;
      }
    | string
    | undefined,
): string => {
  if (!artist) {
    return '';
  }
  if (typeof artist === 'string') {
    return artist;
  }
  return artist.name ?? artist['#text'] ?? '';
};

const pickCover = (images?: LfmImage[]): string | undefined =>
  TrackConverter.pickLargestImage(images);

/**
 * Last.fm sends `playcount` as a string, so it needs coercing. But a bare
 * `Number(x)` returns NaN for a non-numeric string, and NaN renders in an
 * embed as "NaN plays" - a visible glitch that no type checker can catch,
 * since the field is genuinely typed `string`. `?? 0` does not help either:
 * it only catches null/undefined, not a string that simply isn't a number.
 */
const toPlaycount = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

export class TopListConverter {
  public static convertTopArtists(response: TopArtistsResponseLfm): TopArtist[] {
    const artists = Array.isArray(response.topartists.artist)
      ? response.topartists.artist
      : [];
    return artists.map((a) => ({
      name: a.name,
      playcount: toPlaycount(a.playcount),
      mbid: a.mbid || undefined,
      url: a.url || undefined,
    }));
  }

  public static convertTopAlbums(response: TopAlbumsResponseLfm): TopAlbum[] {
    const albums = Array.isArray(response.topalbums.album)
      ? response.topalbums.album
      : [];
    return albums.map((a) => ({
      name: a.name,
      artistName: extractArtistName(a.artist),
      playcount: toPlaycount(a.playcount),
      mbid: a.mbid || undefined,
      url: a.url || undefined,
      imageUrl: pickCover(a.image),
    }));
  }

  public static convertTopTracks(response: TopTracksResponseLfm): TopTrack[] {
    const tracks = Array.isArray(response.toptracks.track)
      ? response.toptracks.track
      : [];
    return tracks.map((t) => ({
      name: t.name,
      artistName: extractArtistName(t.artist),
      playcount: toPlaycount(t.playcount),
      mbid: t.mbid || undefined,
      url: t.url || undefined,
      imageUrl: pickCover(t.image),
    }));
  }

  public static convertWeeklyArtistChart(response: WeeklyArtistChartResponseLfm): TopArtist[] {
    const raw = response?.weeklyartistchart?.artist;
    // `raw ? [raw] : []` is not a typo: a single-entry chart arrives as a bare
    // object, so it is normalized here. See the type's comment.
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((a) => ({
      name: a.name,
      playcount: toPlaycount(a.playcount),
      mbid: a.mbid || undefined,
      url: a.url || undefined,
    }));
  }

  public static convertWeeklyAlbumChart(response: WeeklyAlbumChartResponseLfm): TopAlbum[] {
    const raw = response?.weeklyalbumchart?.album;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((a) => ({
      name: a.name,
      artistName: extractArtistName(a.artist),
      playcount: toPlaycount(a.playcount),
      mbid: a.mbid || undefined,
      url: a.url || undefined,
      imageUrl: pickCover(a.image),
    }));
  }

  public static convertWeeklyTrackChart(response: WeeklyTrackChartResponseLfm): TopTrack[] {
    const raw = response?.weeklytrackchart?.track;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((t) => ({
      name: t.name,
      artistName: extractArtistName(t.artist),
      playcount: toPlaycount(t.playcount),
      mbid: t.mbid || undefined,
      url: t.url || undefined,
      imageUrl: pickCover(t.image),
    }));
  }
}

