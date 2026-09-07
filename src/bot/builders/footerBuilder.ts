import { FmFooterOption } from '@domain/enums/fmFooterOption';
import type { RecentTrack } from '@domain/models/recentTrack';

export function buildFooterText(opts: {
  footerOptions: bigint;
  track: RecentTrack;
  previousTrack?: RecentTrack | null;
  totalScrobbles?: number;
  artistPlays?: number;
  albumPlays?: number;
  trackPlays?: number;
  artistPlaysThisWeek?: number;
  serverArtistListeners?: number;
  serverAlbumListeners?: number;
  serverTrackListeners?: number;
  isLoved?: boolean;
  crownHolder?: string | null;
  useSmallText?: boolean;
}): string {
  const parts: string[] = [];
  const has = (f: FmFooterOption) => (opts.footerOptions & BigInt(f)) !== BigInt(0);

  if (has(FmFooterOption.Loved) && (opts.isLoved || (opts.track as unknown as { loved?: boolean })?.loved)) {
    parts.push('❤️ Loved');
  }
  if (has(FmFooterOption.ArtistPlays) && opts.artistPlays !== undefined) {
    parts.push(`${opts.artistPlays.toLocaleString()} ${opts.artistPlays === 1 ? 'artist play' : 'artist plays'}`);
  }
  if (has(FmFooterOption.AlbumPlays) && opts.albumPlays !== undefined) {
    parts.push(`${opts.albumPlays.toLocaleString()} ${opts.albumPlays === 1 ? 'album play' : 'album plays'}`);
  }
  if (has(FmFooterOption.TrackPlays) && opts.trackPlays !== undefined) {
    parts.push(`${opts.trackPlays.toLocaleString()} ${opts.trackPlays === 1 ? 'track play' : 'track plays'}`);
  }
  if (has(FmFooterOption.ArtistPlaysThisWeek) && opts.artistPlaysThisWeek !== undefined) {
    parts.push(`${opts.artistPlaysThisWeek.toLocaleString()} this week`);
  }
  if (has(FmFooterOption.ServerArtistListeners) && opts.serverArtistListeners !== undefined) {
    parts.push(`${opts.serverArtistListeners} server ${opts.serverArtistListeners === 1 ? 'listener' : 'listeners'}`);
  }
  if (has(FmFooterOption.ServerAlbumListeners) && opts.serverAlbumListeners !== undefined) {
    parts.push(`${opts.serverAlbumListeners} server album ${opts.serverAlbumListeners === 1 ? 'listener' : 'listeners'}`);
  }
  if (has(FmFooterOption.ServerTrackListeners) && opts.serverTrackListeners !== undefined) {
    parts.push(`${opts.serverTrackListeners} server track ${opts.serverTrackListeners === 1 ? 'listener' : 'listeners'}`);
  }
  if (has(FmFooterOption.CrownHolder) && opts.crownHolder) {
    parts.push(`👑 ${opts.crownHolder}`);
  }
  if (has(FmFooterOption.TotalScrobbles) && opts.totalScrobbles !== undefined) {
    parts.push(`${opts.totalScrobbles.toLocaleString()} total scrobbles`);
  }

  const text = parts.join(' · ') || (opts.totalScrobbles !== undefined ? `${opts.totalScrobbles.toLocaleString()} total scrobbles` : '');
  return opts.useSmallText ? `-# ${text}` : text;
}
