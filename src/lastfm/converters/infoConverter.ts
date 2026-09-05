import type {
  AlbumInfoResponseLfm,
  ArtistInfoResponseLfm,
  TrackInfoResponseLfm,
} from '@lastfm/models/infoLfm';
import type { LfmImage } from '@lastfm/models/recentTracksLfm';
import type { AlbumInfo, ArtistInfo, TrackInfo } from '@domain/models/musicInfo';
import { TrackConverter } from './recentTrackConverter';

const stripHtml = (value: string): string =>
  value.replace(/<[^>]*>/g, '').trim();

export class InfoConverter {
  public static convertArtistInfo(response: ArtistInfoResponseLfm): ArtistInfo {
    const artist = response.artist;
    const rawTags = artist.tags?.tag ? (Array.isArray(artist.tags.tag) ? artist.tags.tag : [artist.tags.tag]) : [];
    return {
      name: artist.name,
      mbid: artist.mbid || undefined,
      url: artist.url || undefined,
      imageUrl: TrackConverter.pickLargestImage(artist.image),
      listeners: Number(artist.stats?.listeners ?? 0),
      playCount: Number(artist.stats?.playcount ?? 0),
      userPlayCount: artist.stats?.userplaycount
        ? Number(artist.stats.userplaycount)
        : undefined,
      summary: artist.bio?.summary ? stripHtml(artist.bio.summary) : undefined,
      tags: rawTags.map(t => t.name).filter(Boolean),
    };
  }

  public static convertAlbumInfo(response: AlbumInfoResponseLfm): AlbumInfo {
    const album = response.album;
    const rawTracks = Array.isArray(album.tracks?.track)
      ? album.tracks.track
      : album.tracks?.track
        ? [album.tracks.track]
        : [];

    const tracks = rawTracks.map((t) => ({
      name: t.name,
      durationSeconds: t.duration ? Number(t.duration) : undefined,
      url: t.url,
      rank: t['@attr']?.rank ? Number(t['@attr'].rank) : undefined,
    }));

    return {
      name: album.name,
      artistName: album.artist,
      mbid: album.mbid || undefined,
      url: album.url || undefined,
      imageUrl: TrackConverter.pickLargestImage(album.image),
      listeners: album.listeners ? Number(album.listeners) : undefined,
      playCount: album.playcount ? Number(album.playcount) : undefined,
      userPlayCount: album.userplaycount ? Number(album.userplaycount) : undefined,
      summary: album.wiki?.summary ? stripHtml(album.wiki.summary) : undefined,
      tracks: tracks.length > 0 ? tracks : undefined,
    };
  }

  public static convertTrackInfo(response: TrackInfoResponseLfm): TrackInfo {
    const track = response.track;

    let albumName: string | undefined;
    let albumImage: LfmImage[] | undefined;
    if (typeof track.album === 'string') {
      albumName = track.album;
    } else if (track.album) {
      albumName = track.album.title;
      albumImage = track.album.image;
    }

    const albumCoverUrl = TrackConverter.pickLargestImage(albumImage);
    const tagsRaw = track.toptags?.tag;
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map((t) => t.name)
      : tagsRaw?.name
      ? [tagsRaw.name]
      : undefined;

    return {
      name: track.name,
      artistName: track.artist?.name ?? '',
      albumName: albumName,
      albumCoverUrl,
      mbid: track.mbid || undefined,
      url: track.url || undefined,
      imageUrl: albumCoverUrl || TrackConverter.pickLargestImage(track.image),
      durationSeconds: track.duration && Number(track.duration) > 0
        ? Math.round(Number(track.duration) / 1000)
        : undefined,
      listeners: track.listeners ? Number(track.listeners) : undefined,
      playCount: track.playcount ? Number(track.playcount) : undefined,
      userPlayCount: track.userplaycount ? Number(track.userplaycount) : undefined,
      summary: track.wiki?.summary,
      tags,
      userLoved: track.userloved === '1',
    };
  }
}
