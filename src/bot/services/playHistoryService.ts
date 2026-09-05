import { inject, injectable } from 'tsyringe';
import type { IPlayRepository } from '@domain/interfaces/iplayRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { RecentTrack } from '@domain/models/recentTrack';

const LAST_LISTENED_EXCLUSION_MS = 30 * 60 * 1000; // 30 minutes

export interface DiscoveryDateResult {
  artistFirstPlay: { timePlayed: Date; albumName: string | null; trackName: string | null } | null;
  albumFirstPlayDate: Date | null;
  trackFirstPlayDate: Date | null;
}

export interface LastListenedDateResult {
  artistLastPlay: { timePlayed: Date; albumName: string | null; trackName: string | null } | null;
  albumLastPlayDate: Date | null;
  trackLastPlayDate: Date | null;
}

@injectable()
export class PlayHistoryService {
  constructor(
    @inject('IPlayRepository') private readonly playRepository: IPlayRepository,
    @inject('ILastfmRepository') private readonly lastfmRepository: ILastfmRepository,
  ) {}

  public async getRecentArtistPlaycounts(
    userId: number,
    artistName: string,
  ): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName);
  }

  public async getRecentAlbumPlaycounts(
    userId: number,
    artistName: string,
    albumName: string,
  ): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName, albumName);
  }

  public async getRecentTrackPlaycounts(
    userId: number,
    artistName: string,
    trackName: string,
  ): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName, null, trackName);
  }

  public async getDiscoveryDates(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<DiscoveryDateResult> {
    const artistFirstPlay = await this.playRepository.getEntityFirstPlay(userId, artistName);

    let effectiveAlbum = albumName ?? null;
    let effectiveTrack = trackName ?? null;

    if (artistFirstPlay) {
      if (!effectiveAlbum && artistFirstPlay.albumName) {
        effectiveAlbum = artistFirstPlay.albumName;
      }
      if (!effectiveTrack && artistFirstPlay.trackName) {
        effectiveTrack = artistFirstPlay.trackName;
      }
    }

    const albumFirstPlayDate = effectiveAlbum
      ? await this.playRepository.getEntityFirstPlayDate(userId, artistName, effectiveAlbum, null)
      : null;

    const trackFirstPlayDate = effectiveTrack
      ? await this.playRepository.getEntityFirstPlayDate(userId, artistName, null, effectiveTrack)
      : null;

    return {
      artistFirstPlay,
      albumFirstPlayDate,
      trackFirstPlayDate,
    };
  }

  public async getLastListenedDates(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<LastListenedDateResult> {
    const cutoff = new Date(Date.now() - LAST_LISTENED_EXCLUSION_MS);

    const artistLastPlay = await this.playRepository.getEntityLastPlay(userId, artistName, cutoff);

    let effectiveAlbum = albumName ?? null;
    let effectiveTrack = trackName ?? null;

    if (artistLastPlay) {
      if (!effectiveAlbum && artistLastPlay.albumName) {
        effectiveAlbum = artistLastPlay.albumName;
      }
      if (!effectiveTrack && artistLastPlay.trackName) {
        effectiveTrack = artistLastPlay.trackName;
      }
    }

    const albumLastPlayDate = effectiveAlbum
      ? await this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff, effectiveAlbum, null)
      : null;

    const trackLastPlayDate = effectiveTrack
      ? await this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff, null, effectiveTrack)
      : null;

    return {
      artistLastPlay,
      albumLastPlayDate,
      trackLastPlayDate,
    };
  }

  public async getScrobbleCountFromDate(
    userName: string,
    from?: number | null,
    sessionKey?: string | null,
    to?: number | null,
  ): Promise<number | null> {
    return this.lastfmRepository.getScrobbleCountFromDate(userName, from, sessionKey, to);
  }

  public async getMilestoneScrobble(
    userName: string,
    sessionKey: string | null,
    totalScrobbles: number,
    milestone: number,
  ): Promise<RecentTrack | null> {
    return this.lastfmRepository.getMilestoneScrobble(userName, sessionKey, totalScrobbles, milestone);
  }
}
