import type {
  TopAlbumsResponseLfm,
  TopArtistsResponseLfm,
  TopTracksResponseLfm,
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

export class TopListConverter {
  public static convertTopArtists(response: TopArtistsResponseLfm): TopArtist[] {
    const artists = Array.isArray(response.topartists.artist)
      ? response.topartists.artist
      : [];
    return artists.map((a) => ({
      name: a.name,
      playcount: Number(a.playcount),
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
      playcount: Number(a.playcount),
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
      playcount: Number(t.playcount),
      mbid: t.mbid || undefined,
      url: t.url || undefined,
      imageUrl: pickCover(t.image),
    }));
  }

  public static convertWeeklyArtistChart(response: any): TopArtist[] {
    const raw = response?.weeklyartistchart?.artist;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((a: any) => ({
      name: a.name,
      playcount: Number(a.playcount ?? 0),
      mbid: a.mbid || undefined,
      url: a.url || undefined,
    }));
  }

  public static convertWeeklyAlbumChart(response: any): TopAlbum[] {
    const raw = response?.weeklyalbumchart?.album;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((a: any) => ({
      name: a.name,
      artistName: extractArtistName(a.artist),
      playcount: Number(a.playcount ?? 0),
      mbid: a.mbid || undefined,
      url: a.url || undefined,
      imageUrl: pickCover(a.image),
    }));
  }

  public static convertWeeklyTrackChart(response: any): TopTrack[] {
    const raw = response?.weeklytrackchart?.track;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((t: any) => ({
      name: t.name,
      artistName: extractArtistName(t.artist),
      playcount: Number(t.playcount ?? 0),
      mbid: t.mbid || undefined,
      url: t.url || undefined,
      imageUrl: pickCover(t.image),
    }));
  }
}

