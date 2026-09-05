export interface TopEntityResult {
  name: string;
  entityId: number;
  playcount: number;
}

export interface PlayInsert {
  userId: number;
  artistId?: number;
  albumId?: number;
  trackId?: number;
  artistName: string;
  albumName?: string;
  trackName?: string;
  timePlayed: Date;
  msPlayed?: number;
  playSource?: 'LastFm' | 'SpotifyImport' | 'AppleMusicImport';
}

export interface StoredPlay {
  userPlayId: bigint;
  userId: number;
  artistName: string;
  albumName?: string;
  trackName?: string;
  timePlayed: Date;
  playSource?: string;
}

export interface IPlayRepository {
  batchInsertPlays(plays: PlayInsert[]): Promise<number>;

  getPlayCountSince(userId: number, since?: Date): Promise<number>;

  getTopArtists(userId: number, since?: Date, limit?: number): Promise<TopEntityResult[]>;
  getTopAlbums(userId: number, since?: Date, limit?: number): Promise<TopEntityResult[]>;
  getTopTracks(userId: number, since?: Date, limit?: number): Promise<TopEntityResult[]>;

  getRawTopArtistNames(userId: number): Promise<Array<{ name: string; playcount: number }>>;
  getRawTopAlbumEntries(userId: number): Promise<Array<{ name: string; artistName: string; playcount: number }>>;
  getRawTopTrackEntries(userId: number): Promise<Array<{ name: string; artistName: string; playcount: number }>>;

  replaceUserArtists(
    userId: number,
    entries: Array<{ artistId: number; name: string; playcount: number }>,
  ): Promise<void>;
  replaceUserAlbums(
    userId: number,
    entries: Array<{ albumId: number; name: string; playcount: number }>,
  ): Promise<void>;
  replaceUserTracks(
    userId: number,
    entries: Array<{ trackId: number; name: string; playcount: number }>,
  ): Promise<void>;

  getLastStoredPlayTime(userId: number): Promise<Date | null>;

  deletePlaysBefore(userId: number, before: Date): Promise<void>;
  deleteAllPlaysForUser(userId: number): Promise<void>;

  /** Delta sync: load recent plays for comparison window (LastFm source only) */
  getRecentPlays(userId: number, limit: number): Promise<StoredPlay[]>;

  /** Delta sync: remove specific plays by ID */
  removePlaysByIds(playIds: bigint[]): Promise<number>;

  /** Delta sync: incremental top-list maintenance (fmbot UpdateArtists/Albums/TracksForUser) */
  applyArtistDeltas(userId: number, deltas: Array<{ name: string; artistId: number; delta: number }>): Promise<void>;
  applyAlbumDeltas(userId: number, deltas: Array<{ name: string; artistId: number; albumId: number; delta: number }>): Promise<void>;
  applyTrackDeltas(userId: number, deltas: Array<{ name: string; artistId: number; trackId: number; delta: number }>): Promise<void>;

  /** Play history queries for artistplays/albumplays/trackplays and discoverydate/lastlistened */
  getRecentEntityPlaycounts(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<{ week: number; month: number }>;

  getEntityTotalPlaycount(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<number>;

  getEntityFirstPlay(
    userId: number,
    artistName: string,
  ): Promise<{ timePlayed: Date; albumName: string | null; trackName: string | null } | null>;

  getEntityFirstPlayDate(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<Date | null>;

  getEntityLastPlay(
    userId: number,
    artistName: string,
    cutoff: Date,
  ): Promise<{ timePlayed: Date; albumName: string | null; trackName: string | null } | null>;

  getEntityLastPlayDate(
    userId: number,
    artistName: string,
    cutoff: Date,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<Date | null>;
}

