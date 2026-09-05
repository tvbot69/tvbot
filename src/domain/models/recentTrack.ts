export interface RecentTrack {
  name: string;
  artistName: string;
  albumName: string;
  artistMbid?: string;
  albumMbid?: string;
  trackMbid?: string;
  imageUrl?: string;
  nowPlaying: boolean;
  timePlayed?: Date;
}

export interface RecentTrackList {
  tracks: RecentTrack[];
  totalPages: number;
  totalScrobbles: number;
}
