export interface WhoKnowsDbRow {
  userId: number;
  playcount: number;
  userNameLastFm?: string;
  discordName?: string;
}

export interface IWhoKnowsRepository {
  /**
   * Fetches indexed users for an artist within a specific guild.
   */
  getIndexedUsersForArtist(guildId: string, artistName: string): Promise<WhoKnowsDbRow[]>;

  /**
   * Fetches indexed users for an album within a specific guild.
   */
  getIndexedUsersForAlbum(guildId: string, albumId: number): Promise<WhoKnowsDbRow[]>;

  /**
   * Fetches indexed users for a track within a specific guild.
   */
  getIndexedUsersForTrack(guildId: string, trackId: number): Promise<WhoKnowsDbRow[]>;

  /**
   * Fetches friends of a user who know an artist.
   */
  getFriendUsersForArtist(userId: number, artistName: string, guildId?: string): Promise<WhoKnowsDbRow[]>;

  /**
   * Fetches friends of a user who know an album.
   */
  getFriendUsersForAlbum(userId: number, albumId: number, guildId?: string): Promise<WhoKnowsDbRow[]>;

  /**
   * Fetches friends of a user who know a track.
   */
  getFriendUsersForTrack(userId: number, trackId: number, guildId?: string): Promise<WhoKnowsDbRow[]>;
}
