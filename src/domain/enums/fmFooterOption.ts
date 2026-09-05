export enum FmFooterOption {
  Loved = 1 << 0,
  ArtistPlays = 1 << 1,
  AlbumPlays = 1 << 2,
  TrackPlays = 1 << 3,
  TotalScrobbles = 1 << 4,
  ArtistPlaysThisWeek = 1 << 5,
  ArtistCountry = 1 << 6,
  ArtistBirthday = 1 << 7,
  ArtistGenres = 1 << 8,
  TrackBpm = 1 << 9,
  TrackDuration = 1 << 10,
  DiscogsCollection = 1 << 11,
  ServerArtistListeners = 1 << 12,
  ServerAlbumListeners = 1 << 13,
  ServerTrackListeners = 1 << 14,
  ServerArtistRank = 1 << 15,
  ServerAlbumRank = 1 << 16,
  ServerTrackRank = 1 << 17,
  CrownHolder = 1 << 18,
  GlobalArtistRank = 1 << 19,
  GlobalAlbumRank = 1 << 20,
  GlobalTrackRank = 1 << 21,
  FirstArtistListen = 1 << 22,
  FirstAlbumListen = 1 << 23,
  FirstTrackListen = 1 << 24,
  LastArtistListen = 1 << 25,
  LastAlbumListen = 1 << 26,
  LastTrackListen = 1 << 27,
}

export const DefaultFooterOption = FmFooterOption.TotalScrobbles;

export const FmFooterOptionMeta: Array<{ flag: FmFooterOption; label: string; description: string }> = [
  { flag: FmFooterOption.Loved, label: '❤️ Loved', description: 'Show if loved on Last.fm' },
  { flag: FmFooterOption.ArtistPlays, label: 'Artist Plays', description: 'Your artist playcount' },
  { flag: FmFooterOption.AlbumPlays, label: 'Album Plays', description: 'Your album playcount' },
  { flag: FmFooterOption.TrackPlays, label: 'Track Plays', description: 'Your track playcount' },
  { flag: FmFooterOption.TotalScrobbles, label: 'Total Scrobbles', description: 'Total scrobbles' },
  { flag: FmFooterOption.ArtistPlaysThisWeek, label: 'Artist Plays (week)', description: 'Artist plays this week' },
  { flag: FmFooterOption.ServerArtistListeners, label: 'Server Artist Listeners', description: 'Who else listens in server' },
  { flag: FmFooterOption.ServerAlbumListeners, label: 'Server Album Listeners', description: 'Who else has this album' },
  { flag: FmFooterOption.ServerTrackListeners, label: 'Server Track Listeners', description: 'Who else has this track' },
];

export function footerOptionsToArray(bitmask: number): FmFooterOption[] {
  const out: FmFooterOption[] = [];
  for (const { flag } of FmFooterOptionMeta) {
    if ((bitmask & flag) !== 0) out.push(flag);
  }
  return out;
}
export function footerOptionsHas(bitmask: number, flag: FmFooterOption): boolean {
  return (bitmask & flag) !== 0;
}
