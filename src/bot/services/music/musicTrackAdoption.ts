import type { Track } from 'moonlink.js';
import { spotifyUriToUrl, type MirrorTrack, type MusicTrackRequester } from '@domain/models/music/musicTrack';
import type { Rung } from '@bot/services/music/youtubeHealth';
import { isYoutubeThumb } from '@bot/services/music/musicTrackArtwork';

/**
 * Stamps provider display metadata onto a resolved Lavalink track. The
 * moonlink track keeps its true backend label ('local' for resolver
 * output, otherwise the provider) so failure handling routes correctly;
 * the display model keeps the familiar provider badge. Artwork correctness
 * is handled upstream (ladder pre-clean + override sanitizing), so a plain
 * conditional stamp here can never resurrect a wrong image. A trusted
 * override cover wins over provider art; YouTube thumbnails never qualify.
 *
 * Extracted from MusicService as a free function: it is a pure mutation of
 * its arguments, which is what made it safe to lift out whole.
 */
export const adoptMirrorTrack = (
  lavalinkTrack: Track,
  mirrorTrack: MirrorTrack,
  rung: Rung,
  requester: MusicTrackRequester,
  sourceUrl: string,
  trackOverride?: { title?: string; author?: string; artworkUrl?: string; source?: string },
): void => {
  const record = lavalinkTrack as unknown as Record<string, unknown>;
  // Preserve chapter context: the raw video title is captured in
  // searchTrackWithLadder before this overwrite runs. Fall back to the
  // pre-adoption title when the stash is missing (older queue entries).
  if (typeof record._rawVideoTitle !== 'string' && lavalinkTrack.title) {
    record._rawVideoTitle = lavalinkTrack.title;
  }
  if (typeof record._sourceVideoId !== 'string' && /^[\w-]{11}$/.test(lavalinkTrack.identifier ?? '')) {
    const src = String(record.sourceName ?? '');
    if (src === 'youtube' || src === '') record._sourceVideoId = lavalinkTrack.identifier;
  }
  lavalinkTrack.requester = requester;
  lavalinkTrack.title = mirrorTrack.name;
  lavalinkTrack.author = mirrorTrack.artist;
  if (mirrorTrack.artworkUrl) {
    lavalinkTrack.artworkUrl = mirrorTrack.artworkUrl;
  }
  if (mirrorTrack.album?.trim()) {
    record._album = mirrorTrack.album.trim();
  }
  lavalinkTrack.uri = spotifyUriToUrl(mirrorTrack.spotifyUri) || mirrorTrack.sourceUrl || sourceUrl;
  const backend = rung === 'resolver' ? 'local' : (mirrorTrack.provider ?? 'spotify');
  record.sourceName = trackOverride?.source || backend;
  record.source = trackOverride?.source || backend;
  if (trackOverride?.artworkUrl && !isYoutubeThumb(trackOverride.artworkUrl)) {
    lavalinkTrack.artworkUrl = trackOverride.artworkUrl;
  }
};
