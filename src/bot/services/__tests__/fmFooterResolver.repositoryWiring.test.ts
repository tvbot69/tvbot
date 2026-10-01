import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { FmFooterResolver } from '@bot/services/system/fmFooterResolver';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { ArtistsService } from '@bot/services/library/artistsService';
import { AlbumService } from '@bot/services/library/albumService';
import { TrackService } from '@bot/services/library/trackService';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { FmFooterRepository } from '@persistence/repositories/fmFooterRepository';

/**
 * The seam between `FmFooterResolver` and `FmFooterRepository`, tested from the
 * resolver's side with a repository double and **no `PrismaClient` registered
 * at all**.
 *
 * That omission is the assertion. `container.resolve` on an unregistered class
 * token tries to construct it, and constructing `PrismaClient` needs a real
 * engine, so any surviving `container.resolve(PrismaClient)` in the resolver
 * throws - and the task's `catch` swallows it into a missing footer field. Every
 * field below therefore proves the data came through the repository: reach past
 * it and the count simply is not there.
 *
 * The complementary suite (`fmFooterResolver.test.ts`) doubles Prisma instead,
 * and so pins the query shapes end to end. This file pins the boundary, which
 * that one cannot see.
 */

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

const GUILD = '953703151930847253';

const mask = (...flags: FmFooterOption[]): bigint =>
  flags.reduce<bigint>((acc, f) => acc | BigInt(f), BigInt(0));

const register = (over: Record<string, unknown> = {}) => {
  const deps: Record<string, unknown> = {
    artistsService: { getArtistInfo: vi.fn(async () => ({ name: 'Gunna' })) },
    albumService: { getAlbumInfo: vi.fn(async () => ({ name: 'A Gift & a Curse' })) },
    trackService: { getTrackInfo: vi.fn(async () => null) },
    whoKnowsRepo: {
      getIndexedUsersForArtist: vi.fn(async () => [{ userId: 1, playcount: 5 }]),
      getIndexedUsersForAlbum: vi.fn(async () => [{ userId: 1, playcount: 5 }]),
      getIndexedUsersForTrack: vi.fn(async () => [{ userId: 1, playcount: 5 }]),
    },
    crownRepo: { getCurrentCrown: vi.fn(async () => ({ userNameLastFm: 'DreadRock' })) },
    footerRepo: {
      getUserArtistPlaycount: vi.fn(async () => 11),
      getUserAlbumPlaycount: vi.fn(async () => 12),
      getUserTrackPlaycount: vi.fn(async () => 13),
      countUserArtistPlaysSince: vi.fn(async () => 7),
      findAlbumByNameAndArtist: vi.fn(async () => ({ albumId: 99 })),
      findTrackByNameAndArtist: vi.fn(async () => ({ trackId: 88 })),
    },
    ...over,
  };

  container.registerInstance(ArtistsService, deps.artistsService as never);
  container.registerInstance(AlbumService, deps.albumService as never);
  container.registerInstance(TrackService, deps.trackService as never);
  container.registerInstance(WhoKnowsRepository, deps.whoKnowsRepo as never);
  container.registerInstance(CrownRepository, deps.crownRepo as never);
  container.registerInstance(FmFooterRepository, deps.footerRepo as never);
  return deps;
};

const mockOf = (fn: unknown) => fn as any;

const ALL = [
  FmFooterOption.Loved,
  FmFooterOption.ArtistPlays,
  FmFooterOption.AlbumPlays,
  FmFooterOption.TrackPlays,
  FmFooterOption.ArtistPlaysThisWeek,
  FmFooterOption.ServerArtistListeners,
  FmFooterOption.ServerAlbumListeners,
  FmFooterOption.ServerTrackListeners,
  FmFooterOption.CrownHolder,
];

describe('FmFooterResolver - the database-backed fields come from the repository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('has no PrismaClient to fall back on', () => {
    // The premise of every test in this file. Stated once so a future change
    // that registers Prisma here does not silently turn the rest into
    // assertions about nothing.
    register();
    expect(container.isRegistered(PrismaClient)).toBe(false);
  });

  it('fills every database-backed field with no PrismaClient in the container', async () => {
    register();

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...ALL), GUILD);

    expect(data).toEqual({
      artistPlays: 11,
      albumPlays: 12,
      trackPlays: 13,
      artistPlaysThisWeek: 7,
      serverArtistListeners: 1,
      serverAlbumListeners: 1,
      serverTrackListeners: 1,
      crownHolder: 'DreadRock',
    });
  });

  it('scopes each rollup read to the requesting user', async () => {
    const deps = register();

    await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...ALL), GUILD);

    expect(mockOf(deps.footerRepo).getUserArtistPlaycount).toHaveBeenCalledWith(123, 'Gunna');
    expect(mockOf(deps.footerRepo).getUserAlbumPlaycount).toHaveBeenCalledWith(123, 'A Gift & a Curse');
    expect(mockOf(deps.footerRepo).getUserTrackPlaycount).toHaveBeenCalledWith(123, 'fukumean');
    expect(mockOf(deps.footerRepo).countUserArtistPlaysSince)
      .toHaveBeenCalledWith(123, 'Gunna', expect.any(Date));
  });

  it('hands the week window it measured to the repository rather than a new one', async () => {
    // The window is the caller's clock. If the repository re-derived its own,
    // this would drift and the field would quietly report the wrong week.
    const deps = register();

    await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlaysThisWeek), GUILD,
    );

    const since = mockOf(deps.footerRepo).countUserArtistPlaysSince.mock.calls[0]![2] as Date;
    const daysOut = (Date.now() - since.getTime()) / 86400000;
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  it('feeds the catalogue ids straight into the who-knows lookups', async () => {
    const deps = register();

    await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerAlbumListeners, FmFooterOption.ServerTrackListeners), GUILD,
    );

    expect(mockOf(deps.footerRepo).findAlbumByNameAndArtist)
      .toHaveBeenCalledWith('A Gift & a Curse', 'Gunna');
    expect(mockOf(deps.footerRepo).findTrackByNameAndArtist)
      .toHaveBeenCalledWith('fukumean', 'Gunna');
    expect(mockOf(deps.whoKnowsRepo).getIndexedUsersForAlbum).toHaveBeenCalledWith(GUILD, 99);
    expect(mockOf(deps.whoKnowsRepo).getIndexedUsersForTrack).toHaveBeenCalledWith(GUILD, 88);
  });

  it('asks for nothing when no owned option is set', async () => {
    // Hot path: a footer configured for TotalScrobbles only must not issue a
    // single query. The repository is resolved lazily inside each task for the
    // same reason - resolving it up front would make an unused dependency able
    // to throw outside the per-task catch.
    const deps = register();

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.TotalScrobbles), GUILD,
    );

    expect(data).toEqual({});
    for (const method of [
      'getUserArtistPlaycount',
      'getUserAlbumPlaycount',
      'getUserTrackPlaycount',
      'countUserArtistPlaysSince',
      'findAlbumByNameAndArtist',
      'findTrackByNameAndArtist',
    ]) {
      expect(mockOf(deps.footerRepo)[method], method).not.toHaveBeenCalled();
    }
  });

  it('omits a playcount the repository reports as absent', async () => {
    // `null` means "no such rollup row", which is not zero plays.
    register({ footerRepo: { getUserArtistPlaycount: vi.fn(async () => null) } });

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD,
    );

    expect('artistPlays' in data).toBe(false);
  });

  it('omits a playcount the repository reports as zero', async () => {
    register({ footerRepo: { getUserArtistPlaycount: vi.fn(async () => 0) } });

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD,
    );

    expect('artistPlays' in data).toBe(false);
  });

  it('degrades quietly when every repository call fails', async () => {
    const boom = async () => {
      throw new Error('db down');
    };
    register({
      footerRepo: {
        getUserArtistPlaycount: boom,
        getUserAlbumPlaycount: boom,
        getUserTrackPlaycount: boom,
        countUserArtistPlaysSince: boom,
        findAlbumByNameAndArtist: boom,
        findTrackByNameAndArtist: boom,
      },
    });

    await expect(
      FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...ALL), GUILD),
    ).resolves.toEqual({ serverArtistListeners: 1, crownHolder: 'DreadRock' });
  });
});
