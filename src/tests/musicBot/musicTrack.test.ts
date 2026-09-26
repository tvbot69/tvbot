import { describe, it, expect } from 'vitest';
import {
  cleanTrackTitle,
  cleanArtistName,
  mapMoonlinkTrack,
  isSpotifyMatchValid,
  spotifyUriToUrl,
} from '@domain/models/music/musicTrack';
import type { Track as MoonlinkTrack } from 'moonlink.js';

describe('cleanTrackTitle', () => {
  it('strips official audio and author prefix', () => {
    expect(
      cleanTrackTitle('Lancey Foux - ALL MY GIRLS (Official Audio)', 'Lancey Foux'),
    ).toBe('ALL MY GIRLS');
  });

  it('strips official music video in parentheses and brackets', () => {
    expect(
      cleanTrackTitle('Travis Scott - HIGHEST IN THE ROOM (Official Music Video)', 'Travis Scott'),
    ).toBe('HIGHEST IN THE ROOM');

    expect(
      cleanTrackTitle('Kendrick Lamar - Not Like Us [Official Audio]', 'Kendrick Lamar'),
    ).toBe('Not Like Us');
  });

  it('strips visualizer and HD tags', () => {
    expect(cleanTrackTitle('Carti - Magnolia (Visualizer) [HD]', 'Carti')).toBe('Magnolia');
  });

  it('strips lyric video tags', () => {
    expect(
      cleanTrackTitle('Taylor Swift - Cruel Summer (Official Lyric Video)', 'Taylor Swift'),
    ).toBe('Cruel Summer');
  });

  it('strips remastered tags but preserves legitimate parentheses', () => {
    expect(
      cleanTrackTitle('Queen - Bohemian Rhapsody (Official Video Remastered)', 'Queen'),
    ).toBe('Bohemian Rhapsody');

    expect(
      cleanTrackTitle(
        'A$AP Rocky - Praise The Lord (Da Shine) (Official Video) ft. Skepta',
        'A$AP Rocky',
      ),
    ).toBe('Praise The Lord (Da Shine) ft. Skepta');
  });

  it('strips unbracketed trailing release tags', () => {
    expect(cleanTrackTitle('Song Name - Official Audio', 'Artist')).toBe('Song Name');
    expect(cleanTrackTitle('Song Name | Official Music Video', 'Artist')).toBe('Song Name');
  });

  it('strips international video tags like Clip Officiel and Video Oficial', () => {
    expect(cleanTrackTitle('Stromae - Papaoutai (Clip Officiel)', 'Stromae')).toBe('Papaoutai');
    expect(cleanTrackTitle('Bad Bunny - DÁKITI (Video Oficial)', 'Bad Bunny')).toBe('DÁKITI');
  });

  it('handles empty or missing input gracefully', () => {
    expect(cleanTrackTitle('')).toBe('Unknown Title');
    expect(cleanTrackTitle('Normal Track Title')).toBe('Normal Track Title');
  });

  it('strips bracketed collaborator credits but keeps authors intact', () => {
    expect(cleanTrackTitle('YEAT - CANADA (w/ jnhygs)', 'YEAT')).toBe('CANADA');
    expect(cleanTrackTitle('A - Song (feat. X)', 'A')).toBe('Song');
    expect(cleanTrackTitle('A - Song [ft. Y]', 'A')).toBe('Song');
    expect(cleanTrackTitle('A - Song (Featuring Z)', 'A')).toBe('Song');
    // Unbracketed credits stay (author-prefix rule territory, not this one).
    expect(
      cleanTrackTitle('A$AP Rocky - Praise The Lord (Da Shine) (Official Video) ft. Skepta', 'A$AP Rocky'),
    ).toBe('Praise The Lord (Da Shine) ft. Skepta');
  });
});

describe('cleanArtistName', () => {
  it('strips - Topic and VEVO suffixes from YouTube artist names', () => {
    expect(cleanArtistName('Lancey Foux - Topic')).toBe('Lancey Foux');
    expect(cleanArtistName('TheWeekndVEVO')).toBe('TheWeeknd');
    expect(cleanArtistName('Queen')).toBe('Queen');
  });

  it('handles undefined artist gracefully', () => {
    expect(cleanArtistName(undefined)).toBe('Unknown Artist');
  });
});

describe('mapMoonlinkTrack', () => {
  it('cleans title and author when mapping from Moonlink track', () => {
    const rawTrack = {
      identifier: 'xyz123',
      title: 'Lancey Foux - ALL MY GIRLS (Official Audio)',
      author: 'Lancey Foux - Topic',
      uri: 'https://youtube.com/watch?v=xyz123',
      duration: 180000,
      isSeekable: true,
      isStream: false,
      thumbnail: 'https://img.youtube.com/vi/xyz123/default.jpg',
      sourceName: 'youtube',
    } as unknown as MoonlinkTrack;

    const mapped = mapMoonlinkTrack(rawTrack);
    expect(mapped.title).toBe('ALL MY GIRLS');
    expect(mapped.author).toBe('Lancey Foux');
    expect(mapped.artworkUrl).toBeUndefined();
    expect(mapped.source).toBe('youtube');
  });

  it('correctly maps Spotify sources even if resolved via YouTube audio stream', () => {
    const spotifyTrack = {
      identifier: 'sp123',
      title: 'Starboy',
      author: 'The Weeknd',
      uri: 'https://open.spotify.com/track/sp123',
      duration: 230000,
      source: 'spotify',
      sourceName: 'spotify',
    } as unknown as MoonlinkTrack;

    expect(mapMoonlinkTrack(spotifyTrack).source).toBe('spotify');

    const spotifyUriTrack = {
      identifier: 'spotify:track:456',
      title: 'Reminder',
      author: 'The Weeknd',
      uri: 'https://open.spotify.com/track/456',
      duration: 210000,
    } as unknown as MoonlinkTrack;

    expect(mapMoonlinkTrack(spotifyUriTrack).source).toBe('spotify');
  });

  it('correctly maps SoundCloud tracks', () => {
    const soundcloudTrack = {
      identifier: 'sc123',
      title: 'Indie Song',
      author: 'Indie Artist',
      uri: 'https://soundcloud.com/artist/indie-song',
      duration: 190000,
      sourceName: 'soundcloud',
    } as unknown as MoonlinkTrack;

    expect(mapMoonlinkTrack(soundcloudTrack).source).toBe('soundcloud');
  });

  it('drops YouTube thumbnails instead of upgrading them (frames are not artwork)', () => {
    const ytTrack = {
      identifier: 'cxk-1zsy_W8',
      title: 'PLAYBOI CARTI LIVE @ Rolling Loud Cali 2023 [FULL SET]',
      author: 'Rolling Loud',
      uri: 'https://www.youtube.com/watch?v=cxk-1zsy_W8',
      duration: 2108000,
      thumbnail: 'https://img.youtube.com/vi/cxk-1zsy_W8/mqdefault.jpg',
      sourceName: 'youtube',
    } as unknown as MoonlinkTrack;

    // The card must never show a video frame: this mapper runs on every read,
    // so stamping a thumbnail here would out-resolve the artwork cascade.
    expect(mapMoonlinkTrack(ytTrack).artworkUrl).toBeUndefined();
  });

  it('keeps a real resolved cover on a YouTube-sourced track', () => {
    const ytTrack = {
      identifier: 'cxk-1zsy_W8',
      title: 'Rottweiler',
      author: 'EsDeeKid',
      uri: 'https://www.youtube.com/watch?v=cxk-1zsy_W8',
      duration: 210000,
      artworkUrl: 'https://i.scdn.co/image/rottweiler-cover',
      sourceName: 'youtube',
    } as unknown as MoonlinkTrack;

    expect(mapMoonlinkTrack(ytTrack).artworkUrl).toBe('https://i.scdn.co/image/rottweiler-cover');
  });
});

describe('spotifyUriToUrl', () => {
  it('converts spotify: URIs to open URLs for clickable embeds', () => {
    expect(spotifyUriToUrl('spotify:track:2c8SrKXIBNrEiG4eLfk6XD')).toBe(
      'https://open.spotify.com/track/2c8SrKXIBNrEiG4eLfk6XD',
    );
    expect(spotifyUriToUrl('spotify:playlist:73VZK7BqgCVuZr5Z3rv40k')).toBe(
      'https://open.spotify.com/playlist/73VZK7BqgCVuZr5Z3rv40k',
    );
  });

  it('passes through open URLs, video URLs, and empties', () => {
    expect(spotifyUriToUrl('https://open.spotify.com/track/abc')).toBe('https://open.spotify.com/track/abc');
    expect(spotifyUriToUrl('https://youtube.com/watch?v=abc')).toBe('https://youtube.com/watch?v=abc');
    expect(spotifyUriToUrl(undefined)).toBe('');
    expect(spotifyUriToUrl('')).toBe('');
  });
});

describe('isSpotifyMatchValid', () => {
  it('rejects match when duration differs drastically (e.g. 35-minute concert vs 4-minute song)', () => {
    const originalTrack = {
      title: 'PLAYBOI CARTI LIVE @ Rolling Loud Cali 2023 [FULL SET]',
      author: 'Rolling Loud',
      duration: 2108000, // 35 minutes
    };
    const spotifyCandidate = {
      name: 'Mo City Don',
      artist: 'Z-Ro',
      durationMs: 265213, // 4.4 minutes
    };

    expect(isSpotifyMatchValid(originalTrack, spotifyCandidate)).toBe(false);
  });

  it('rejects match when tokens and names have zero overlap', () => {
    const originalTrack = {
      title: 'Playboi Carti - Magnolia',
      author: 'Playboi Carti',
      duration: 180000,
    };
    const spotifyCandidate = {
      name: 'Mo City Don',
      artist: 'Z-Ro',
      durationMs: 185000,
    };

    expect(isSpotifyMatchValid(originalTrack, spotifyCandidate)).toBe(false);
  });

  it('accepts match when title and artist match closely', () => {
    const originalTrack = {
      title: 'Queen - Bohemian Rhapsody (Official Video Remastered)',
      author: 'Queen',
      duration: 354000,
    };
    const spotifyCandidate = {
      name: 'Bohemian Rhapsody',
      artist: 'Queen',
      durationMs: 354000,
    };

    expect(isSpotifyMatchValid(originalTrack, spotifyCandidate)).toBe(true);
  });

  it('accepts match when track title is a substring of the candidate', () => {
    const originalTrack = {
      title: 'FE!N',
      author: 'Travis Scott',
      duration: 191000,
    };
    const spotifyCandidate = {
      name: 'FE!N (feat. Playboi Carti)',
      artist: 'Travis Scott',
      durationMs: 191000,
    };

    expect(isSpotifyMatchValid(originalTrack, spotifyCandidate)).toBe(true);
  });
});
