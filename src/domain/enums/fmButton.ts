export enum FmButton {
  LastFmTrackLink = 1 << 0,
  LastFmAlbumLink = 1 << 1,
  LastFmArtistLink = 1 << 2,
  LastFmUserLibraryLink = 1 << 3,
  SpotifyLink = 1 << 4,
  AppleMusicLink = 1 << 5,
  RymLink = 1 << 6,
  TrackDetails = 1 << 7,
  TrackPreview = 1 << 8,
  TrackLove = 1 << 9,
  TrackUnlove = 1 << 10,
  TrackLyrics = 1 << 11,
  AlbumCover = 1 << 12,
  AlbumTracks = 1 << 13,
  ArtistTracks = 1 << 14,
}

export interface FmButtonMeta {
  flag: FmButton;
  label: string;
  emoji: string;
  customId?: string;
  requiresDbTrack?: boolean;
  isLink?: boolean;
}

export const FmButtonMetaList: FmButtonMeta[] = [
  { flag: FmButton.LastFmTrackLink, label: 'Last.fm Track', emoji: '🔗', isLink: true },
  { flag: FmButton.LastFmAlbumLink, label: 'Last.fm Album', emoji: '💿', isLink: true },
  { flag: FmButton.LastFmArtistLink, label: 'Last.fm Artist', emoji: '🎤', isLink: true },
  { flag: FmButton.LastFmUserLibraryLink, label: 'Library', emoji: '📚', isLink: true },
  { flag: FmButton.SpotifyLink, label: 'Spotify', emoji: '🟢', isLink: true, requiresDbTrack: true },
  { flag: FmButton.ArtistTracks, label: 'Artist Tracks', emoji: '🎵', customId: 'artist-tracks' },
  { flag: FmButton.AlbumCover, label: 'Cover', emoji: '🖼️', customId: 'album-cover' },
  { flag: FmButton.AlbumTracks, label: 'Album Tracks', emoji: '💿', customId: 'album-tracks' },
];
