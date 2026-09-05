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
  useSmallText?: boolean;
}): string {
  const parts: string[] = [];
  const has = (f: FmFooterOption) => (opts.footerOptions & BigInt(f)) !== BigInt(0);
  if (has(FmFooterOption.Loved) && (opts.track as unknown as { loved?: boolean })?.loved) parts.push('❤️ Loved');
  if (has(FmFooterOption.ArtistPlays) && opts.artistPlays !== undefined) parts.push(`${opts.artistPlays} artist plays`);
  if (has(FmFooterOption.AlbumPlays) && opts.albumPlays !== undefined) parts.push(`${opts.albumPlays} album plays`);
  if (has(FmFooterOption.TrackPlays) && opts.trackPlays !== undefined) parts.push(`${opts.trackPlays} track plays`);
  if (has(FmFooterOption.TotalScrobbles) && opts.totalScrobbles !== undefined) parts.push(`${opts.totalScrobbles.toLocaleString()} total scrobbles`);
  const text = parts.join(' · ') || (opts.totalScrobbles !== undefined ? `${opts.totalScrobbles.toLocaleString()} total scrobbles` : '');
  return opts.useSmallText ? `-# ${text}` : text;
}
