import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { FmFooterResolver } from './fmFooterResolver';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { ArtistsService } from './artistsService';
import { AlbumService } from './albumService';
import { TrackService } from './trackService';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';

describe('FmFooterResolver', () => {
  const dummyUser: User = {
    userId: 123,
    discordUserId: '687636049576722472',
    userNameLastFm: 'Moha504',
    sessionKey: 'test-session',
    lastUsed: new Date(),
  } as User;

  const dummyTrack: RecentTrack = {
    name: 'fukumean',
    artistName: 'Gunna',
    albumName: 'A Gift & a Curse',
    nowPlaying: true,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty data immediately if only TotalScrobbles is enabled', async () => {
    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      BigInt(FmFooterOption.TotalScrobbles),
      '953703151930847253',
    );
    expect(data).toEqual({});
  });

  it('returns empty data if track or artist is missing', async () => {
    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      null,
      BigInt(FmFooterOption.ArtistPlays),
      '953703151930847253',
    );
    expect(data).toEqual({});
  });

  it('resolves artist plays, track plays, loved status, and server listeners when flags are active', async () => {
    const mockArtistsService = {
      getArtistInfo: vi.fn().mockResolvedValue({ userPlayCount: 263 }),
    };
    const mockTrackService = {
      getTrackInfo: vi.fn().mockResolvedValue({ userPlayCount: 3, userLoved: true }),
    };
    const mockAlbumService = {
      getAlbumInfo: vi.fn().mockResolvedValue({ userPlayCount: 45 }),
    };
    const mockWhoKnowsRepo = {
      getIndexedUsersForArtist: vi.fn().mockResolvedValue([
        { userId: 123, playcount: 263 },
        { userId: 456, playcount: 10 },
      ]),
    };

    container.registerInstance(ArtistsService, mockArtistsService as any);
    container.registerInstance(TrackService, mockTrackService as any);
    container.registerInstance(AlbumService, mockAlbumService as any);
    container.registerInstance(WhoKnowsRepository, mockWhoKnowsRepo as any);

    const flags =
      BigInt(FmFooterOption.ArtistPlays) |
      BigInt(FmFooterOption.AlbumPlays) |
      BigInt(FmFooterOption.TrackPlays) |
      BigInt(FmFooterOption.Loved) |
      BigInt(FmFooterOption.ServerArtistListeners);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      flags,
      '953703151930847253',
    );

    expect(data.artistPlays).toBe(263);
    expect(data.albumPlays).toBe(45);
    expect(data.trackPlays).toBe(3);
    expect(data.isLoved).toBe(true);
    expect(data.serverArtistListeners).toBe(2);
  });
});
