import { describe, it, expect, vi } from 'vitest';
import { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import type { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';

describe('SpotifyResolver', () => {
  const mockTokenManager = {
    getToken: vi.fn().mockResolvedValue('mock-token-123'),
    invalidate: vi.fn(),
  } as unknown as SpotifyTokenManager;

  const resolver = new SpotifyResolver(mockTokenManager);

  it('correctly identifies Spotify URLs', () => {
    expect(resolver.isSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
    expect(resolver.isSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')).toBe(true);
    expect(resolver.isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe(true);
    expect(resolver.isSpotifyUrl('https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02')).toBe(true);
    expect(resolver.isSpotifyUrl('https://open.spotify.com/intl-es/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
    expect(resolver.isSpotifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(resolver.isSpotifyUrl('radiohead creep')).toBe(false);
  });

  it('correctly parses Spotify URL types and IDs', () => {
    const parsedTrack = resolver.parseSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    expect(parsedTrack).toEqual({ type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });

    const parsedAlbum = resolver.parseSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
    expect(parsedAlbum).toEqual({ type: 'album', id: '1DFixLWuPkv3KT3TnV35m3' });

    const parsedPlaylist = resolver.parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(parsedPlaylist).toEqual({ type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });

    const parsedArtist = resolver.parseSpotifyUrl('https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02');
    expect(parsedArtist).toEqual({ type: 'artist', id: '06HL4z0CvFAxyc27GXpf02' });
  });

  it('searchTracks returns empty array when query is blank or token is unavailable', async () => {
    expect(await resolver.searchTracks('')).toEqual([]);
    expect(await resolver.searchTracks('   ')).toEqual([]);
  });
});
