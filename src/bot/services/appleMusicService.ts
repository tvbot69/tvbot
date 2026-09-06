import { injectable } from 'tsyringe';
import { Logger } from '@domain/logger';

export interface AppleMusicItem {
  trackName: string;
  artistName: string;
  albumName?: string;
  url: string;
  artworkUrl?: string;
}

@injectable()
export class AppleMusicService {
  public async searchSong(query: string): Promise<AppleMusicItem | null> {
    try {
      const url = new URL('https://itunes.apple.com/search');
      url.searchParams.set('term', query);
      url.searchParams.set('entity', 'song');
      url.searchParams.set('limit', '1');

      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;

      const data = (await response.json()) as any;
      const track = data?.results?.[0];
      if (!track) return null;

      return {
        trackName: track.trackName,
        artistName: track.artistName,
        albumName: track.collectionName,
        url: track.trackViewUrl,
        artworkUrl: track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '600x600bb') : undefined,
      };
    } catch (err) {
      Logger.warn({ err, query }, '[AppleMusicService] Search request failed');
      return null;
    }
  }

  public async searchAlbum(query: string): Promise<string | null> {
    try {
      const url = new URL('https://itunes.apple.com/search');
      url.searchParams.set('term', query);
      url.searchParams.set('entity', 'album');
      url.searchParams.set('limit', '1');

      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;

      const data = (await response.json()) as any;
      const album = data?.results?.[0];
      return album?.collectionViewUrl ?? null;
    } catch (err) {
      Logger.warn({ err, query }, '[AppleMusicService] Album search request failed');
      return null;
    }
  }

  public async searchArtist(query: string): Promise<string | null> {
    try {
      const url = new URL('https://itunes.apple.com/search');
      url.searchParams.set('term', query);
      url.searchParams.set('entity', 'musicArtist');
      url.searchParams.set('limit', '1');

      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;

      const data = (await response.json()) as any;
      const artist = data?.results?.[0];
      return artist?.artistLinkUrl ?? null;
    } catch (err) {
      Logger.warn({ err, query }, '[AppleMusicService] Artist search request failed');
      return null;
    }
  }
}
