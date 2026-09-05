export interface LastFmUser {
  name: string;
  realName?: string;
  playCount: number;
  registeredAt?: Date;
  country?: string;
  imageUrl?: string;
  artistCount?: number;
  albumCount?: number;
  trackCount?: number;
}
