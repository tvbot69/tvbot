import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { TimePeriod } from '@domain/enums/timePeriod';
import { ArtistTrackService } from './artistTrackService';

const db = vi.hoisted(() => ({
  artist: { findMany: vi.fn() },
  userArtist: { aggregate: vi.fn() },
  userPlay: { groupBy: vi.fn(), count: vi.fn() },
  userTrack: { findMany: vi.fn() },
  userAlbum: { findMany: vi.fn() },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: db }));

const reset = () => {
  db.artist.findMany.mockResolvedValue([]);
  db.userArtist.aggregate.mockResolvedValue({ _sum: { playcount: null } });
  db.userPlay.groupBy.mockResolvedValue([]);
  db.userPlay.count.mockResolvedValue(0);
  db.userTrack.findMany.mockResolvedValue([]);
  db.userAlbum.findMany.mockResolvedValue([]);
};

describe('ArtistTrackService multi-id aggregation', () => {
  it('sums userArtist rows across duplicate ids instead of picking one', async () => {
    reset();
    db.artist.findMany.mockResolvedValue([{ artistId: 2 }, { artistId: 66 }]);
    db.userArtist.aggregate.mockResolvedValue({ _sum: { playcount: 2296 } });
    const svc = new ArtistTrackService();
    await expect(svc.getTotalArtistPlays(1, 'Mac DeMarco')).resolves.toBe(2296);
    expect(db.userArtist.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 1, artistId: { in: [2, 66] } },
    });
  });

  it('falls back to the userPlay count when no aggregate rows exist', async () => {
    reset();
    db.artist.findMany.mockResolvedValue([{ artistId: 2 }]);
    db.userArtist.aggregate.mockResolvedValue({ _sum: { playcount: null } });
    db.userPlay.count.mockResolvedValue(100);
    const svc = new ArtistTrackService();
    await expect(svc.getTotalArtistPlays(1, 'Mac DeMarco')).resolves.toBe(100);
  });

  it('queries userTracks across every matching id', async () => {
    reset();
    db.artist.findMany.mockResolvedValue([{ artistId: 2 }, { artistId: 66 }]);
    const svc = new ArtistTrackService();
    await svc.getTopTracksForArtist(1, 'Mac DeMarco');
    expect(db.userTrack.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ track: { artistId: { in: [2, 66] } } }) }),
    );
  });

  it('sums spelling variants within a source and takes MAX across sources', async () => {
    reset();
    db.artist.findMany.mockResolvedValue([{ artistId: 66 }]);
    db.userTrack.findMany.mockResolvedValue([{ name: 'Song', playcount: 100 }]);
    db.userPlay.groupBy.mockResolvedValue([
      { trackName: 'SONG', _count: { trackName: 50 } },
      { trackName: 'Other', _count: { trackName: 10 } },
    ]);
    const svc = new ArtistTrackService();
    const tracks = await svc.getTopTracksForArtist(1, 'Mac DeMarco');
    expect(tracks).toEqual([
      { name: 'Song', playcount: 100 },
      { name: 'Other', playcount: 10 },
    ]);
  });

  it('sums split userPlay groups instead of taking MAX', async () => {
    reset();
    db.artist.findMany.mockResolvedValue([]);
    db.userPlay.groupBy.mockResolvedValue([
      { trackName: 'Song', _count: { trackName: 60 } },
      { trackName: 'SONG', _count: { trackName: 40 } },
    ]);
    const svc = new ArtistTrackService();
    const tracks = await svc.getTopTracksForArtist(1, 'Mac DeMarco');
    expect(tracks).toEqual([{ name: 'Song', playcount: 100 }]);
  });

  it('merges weekly spelling variants by summing', async () => {
    reset();
    db.artist.findMany.mockResolvedValue([{ artistId: 66 }]);
    db.userPlay.groupBy.mockResolvedValue([
      { trackName: 'X', _count: { trackName: 10 } },
      { trackName: 'x', _count: { trackName: 5 } },
    ]);
    const svc = new ArtistTrackService();
    const tracks = await svc.getTopTracksForArtist(1, 'Mac DeMarco', TimePeriod.Weekly);
    expect(tracks).toEqual([{ name: 'X', playcount: 15 }]);
  });
});
