import type { Track as MoonlinkTrack } from 'moonlink.js';

export interface MusicTrackRequester {
  id: string;
  tag?: string;
  avatarUrl?: string;
}

export interface MusicTrack {
  identifier: string;
  title: string;
  author: string;
  uri: string;
  duration: number; // in milliseconds
  isSeekable: boolean;
  isStream: boolean;
  artworkUrl?: string;
  source: string;
  requester?: MusicTrackRequester;
}

export const formatDuration = (ms: number): string => {
  if (ms <= 0 || !Number.isFinite(ms)) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const secondsStr = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    const minutesStr = minutes.toString().padStart(2, '0');
    return `${hours}:${minutesStr}:${secondsStr}`;
  }
  return `${minutes}:${secondsStr}`;
};

export const cleanArtistName = (author?: string): string => {
  if (!author) return 'Unknown Artist';
  const clean = author
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .trim();
  return clean.length > 0 ? clean : author.trim();
};

/**
 * Trims release tags, video/audio cruft, and redundant author prefixes from track titles.
 * e.g. "Lancey Foux - ALL MY GIRLS (Official Audio)" -> "ALL MY GIRLS"
 */
export const cleanTrackTitle = (title: string, author?: string): string => {
  if (!title) return 'Unknown Title';

  let clean = title.trim();

  // 1. Strip redundant "Author - " or "Author : " prefix from title if present
  if (author) {
    const escapedAuthor = cleanArtistName(author).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escapedAuthor.length > 0) {
      clean = clean.replace(new RegExp(`^${escapedAuthor}\\s*[-–—:]\\s*`, 'i'), '');
    }
  }

  // 2. Strong trimmer for brackets and parentheses containing video/audio/release cruft
  const cruftPatterns = [
    // Bracketed / parenthesized release tags: (Official Audio), [Official Video], (Visualizer), etc.
    /\s*[([{\u3010][^()\[\]{}\u3010\u3011]*?(?:official\s*(?:audio|video|music\s*video|visualizer|lyric\s*video|track|stream|release)?|music\s*video|audio|video|visualizer|lyric\s*video|lyrics|hd|hq|4k|remaster(?:ed)?(?:\s*\d{4})?|clip\s*officiel|video\s*oficial|audio\s*oficial|explicit(?:\s*version)?|clean(?:\s*version)?)[^()\[\]{}\u3010\u3011]*?[)\]}\u3011]/gi,
    // Trailing unbracketed cruft like "- Official Audio" or "| Official Video"
    /\s*[-–—|/]\s*(?:official\s*(?:audio|video|music\s*video|visualizer|lyric\s*video|track|release)?|music\s*video|visualizer|lyric\s*video|audio)\s*$/gi,
    // Unbracketed trailing "Official Audio"
    /\s+official\s+(?:audio|video|music\s*video|visualizer|lyric\s*video)\s*$/gi,
  ];

  for (const pattern of cruftPatterns) {
    clean = clean.replace(pattern, '');
  }

  // 3. Clean up leftover trailing separators or whitespace
  clean = clean.replace(/\s*[-–—|/]\s*$/, '').trim();

  return clean.length > 0 ? clean : title.trim();
};

export interface SpotifyMatchCandidate {
  name: string;
  artist: string;
  durationMs?: number;
  artworkUrl?: string;
  spotifyUri?: string;
}

export const isSpotifyMatchValid = (
  originalTrack: { title: string; author?: string; duration?: number },
  candidate: SpotifyMatchCandidate,
): boolean => {
  if (!candidate.name?.trim()) return false;

  const origTitle = (originalTrack.title || '').toLowerCase();
  const origAuthor = (originalTrack.author || '').toLowerCase();
  const candName = candidate.name.toLowerCase().trim();
  const candArtist = (candidate.artist || '').toLowerCase().trim();

  // 1. Duration check
  const origDuration = originalTrack.duration || 0;
  const candDuration = candidate.durationMs || 0;
  if (origDuration > 0 && candDuration > 0) {
    // If the original track is a long video/set (>10 mins / 600,000 ms), reject if difference > 60s
    if (origDuration > 600_000 && Math.abs(origDuration - candDuration) > 60_000) {
      return false;
    }
    // For standard songs, if duration differs by more than 45 seconds, reject unless exact match
    if (
      Math.abs(origDuration - candDuration) > 45_000 &&
      !origTitle.includes(candName) &&
      !candName.includes(origTitle)
    ) {
      return false;
    }
  }

  // 2. Token overlap check (tokens length >= 3)
  const getTokens = (str: string) =>
    (str.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);

  const origTokens = new Set([...getTokens(origTitle), ...getTokens(origAuthor)]);
  const candNameTokens = getTokens(candName);
  const candArtistTokens = getTokens(candArtist);

  const nameOverlap = candNameTokens.some((t) => origTokens.has(t));
  const artistOverlap = candArtistTokens.some((t) => origTokens.has(t));

  const substringMatch =
    (candName.length >= 3 && origTitle.includes(candName)) ||
    (origTitle.length >= 3 && candName.includes(origTitle)) ||
    (candArtist.length >= 3 && origTitle.includes(candArtist)) ||
    (candArtist.length >= 3 && origAuthor.includes(candArtist));

  return nameOverlap || artistOverlap || substringMatch;
};

export const mapMoonlinkTrack = (
  track: MoonlinkTrack,
  requester?: MusicTrackRequester,
): MusicTrack => {
  const author = cleanArtistName(track.author);
  const title = cleanTrackTitle(track.title || 'Unknown Title', author);

  const rawTrack = track as unknown as Record<string, unknown>;
  const explicitSource = String(rawTrack.source || rawTrack.sourceName || '').toLowerCase();
  const uri = String(track.uri || '').toLowerCase();
  const identifier = String(track.identifier || '').toLowerCase();

  let source = 'youtube';
  if (
    explicitSource === 'spotify' ||
    (!explicitSource && (uri.includes('spotify.com') || identifier.startsWith('spotify:')))
  ) {
    source = 'spotify';
  } else if (
    explicitSource === 'soundcloud' ||
    (!explicitSource && uri.includes('soundcloud.com'))
  ) {
    source = 'soundcloud';
  } else if (
    explicitSource === 'youtube' ||
    (!explicitSource && (uri.includes('youtube.com') || uri.includes('youtu.be')))
  ) {
    source = 'youtube';
  } else if (explicitSource) {
    source = explicitSource;
  }

  let artworkUrl: string | undefined =
    (rawTrack.artworkUrl as string) || track.artworkUrl || track.thumbnail || undefined;

  // Enhance YouTube thumbnail resolution if applicable
  if (source === 'youtube') {
    const ytIdMatch = track.identifier?.match(/^[a-zA-Z0-9_-]{11}$/)
      ? track.identifier
      : (track.uri?.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:[&?]|$)/)?.[1] || track.identifier);

    if (ytIdMatch) {
      if (!artworkUrl || artworkUrl.includes('mqdefault.jpg')) {
        artworkUrl = `https://i.ytimg.com/vi/${ytIdMatch}/hqdefault.jpg`;
      }
    }
  }

  return {
    identifier: track.identifier || '',
    title,
    author,
    uri: track.uri || '',
    duration: track.duration || 0,
    isSeekable: track.isSeekable ?? true,
    isStream: track.isStream ?? false,
    artworkUrl,
    source,
    requester: (track.requester as MusicTrackRequester) || requester,
  };
};

