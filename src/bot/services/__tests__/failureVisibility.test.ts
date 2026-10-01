/**
 * The two silent-catch bugs where a database failure returned a plausible
 * default that meant the opposite of the truth.
 *
 * Both are the same shape as the `albumService` bug Phase 6.2 is about: the
 * catch returned something, the caller could not tell a default from a fact,
 * and total failure rendered as success. The distinction that makes these two
 * different from the ~57 remaining ones is that the swallowed failure did not
 * degrade a decoration — it inverted a data-integrity guarantee and a security
 * control.
 *
 * Every test here asserts BEHAVIOUR (refused / rejected / not called), never
 * that a log line exists. Logging is necessary and is asserted as a floor, but
 * a test that only watches stdout passes against the old code just as happily.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import type { PrismaClient } from '@prisma/client';
import { ImportService } from '../importService';
import { LoginService, LoginStatus } from '../loginService';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { Logger } from '@domain/logger';

const SAMPLE = [
  {
    ts: '2023-01-01T12:00:00Z',
    master_metadata_track_name: 'Paranoid Android',
    master_metadata_album_artist_name: 'Radiohead',
    master_metadata_album_album_name: 'OK Computer',
    ms_played: 380000,
  },
  {
    ts: '2023-01-02T15:00:00Z',
    master_metadata_track_name: 'One More Time',
    master_metadata_album_artist_name: 'Daft Punk',
    master_metadata_album_album_name: 'Discovery',
    ms_played: 320000,
  },
];

describe('ImportService — a failed dedup lookup is not "nothing to skip"', () => {
  let mockPrisma: {
    user: { update: ReturnType<typeof vi.fn> };
    userPlay: { deleteMany: ReturnType<typeof vi.fn> };
  };
  let service: ImportService;
  let batchInsertPlays: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPrisma = {
      user: { update: vi.fn().mockResolvedValue({}) },
      userPlay: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    service = new ImportService(mockPrisma as unknown as PrismaClient);
    batchInsertPlays = vi.fn(async (rows: unknown[]) => rows.length);
  });

  afterEach(() => {
    container.clearInstances();
    vi.restoreAllMocks();
  });

  const wireRepo = (findExistingPlayKeys: () => Promise<Set<string>>) => {
    container.registerInstance(PlayRepository, { findExistingPlayKeys, batchInsertPlays } as never);
  };

  it('refuses the import when the duplicate-key lookup fails', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    wireRepo(async () => {
      throw new Error('P1001: Cannot reach database server');
    });

    // The old code caught this and answered `new Set()`, which reads as "no
    // plays to skip" and re-inserts exactly what the feature exists to prevent.
    await expect(service.parseAndImport(123, JSON.stringify(SAMPLE))).rejects.toThrow(
      /could not check your library/i,
    );
    expect(batchInsertPlays).not.toHaveBeenCalled();
    // The counter must not move: no rows were stored, so an increment here is
    // the permanently-wrong totalPlayCount from the same audit.
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('refuses to claim success when the insert fails', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    wireRepo(async () => new Set<string>());
    batchInsertPlays.mockRejectedValue(new Error('P2002: unique constraint failed'));

    // The old code caught this and returned 0, so the caller logged "successfully
    // imported 2 scrobbles" and rendered a green card for a batch that stored
    // nothing.
    await expect(service.parseAndImport(123, JSON.stringify(SAMPLE))).rejects.toThrow(
      /could not save any of the 2 new plays/i,
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('still imports normally when both repository calls succeed', async () => {
    wireRepo(async () => new Set<string>());

    const result = await service.parseAndImport(123, JSON.stringify(SAMPLE));

    expect(result.newRowsInserted).toBe(2);
    expect(result.totalScrobblesImported).toBe(2);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { userId: 123 },
      data: { totalPlayCount: { increment: 2 } },
    });
  });

  it('still treats a re-upload as a no-op', async () => {
    wireRepo(
      async () =>
        new Set([
          `${new Date('2023-01-01T12:00:00Z').getTime()}|Radiohead|Paranoid Android`,
          `${new Date('2023-01-02T15:00:00Z').getTime()}|Daft Punk|One More Time`,
        ]),
    );

    const result = await service.parseAndImport(123, JSON.stringify(SAMPLE));

    expect(result.newRowsInserted).toBe(0);
    expect(batchInsertPlays).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('LoginService — the alt-account guard fails CLOSED', () => {
  const makeService = (countUsersByLastFmName: () => Promise<number>) => {
    const setUserLastFm = vi.fn(async () => ({ userId: 9 }));
    const setSessionKey = vi.fn(async () => undefined);
    const cacheDelete = vi.fn(async () => undefined);
    const indexUser = vi.fn(async () => undefined);
    const service = new LoginService(
      { getAuthSession: vi.fn(async () => ({ name: 'SomeUser', key: 'sk' })) } as never,
      { setUserLastFm, getUserByDiscordId: vi.fn(async () => null) } as never,
      {
        get: vi.fn(async () => 'pending-token'),
        set: vi.fn(async () => undefined),
        delete: cacheDelete,
      } as never,
      { indexUser } as never,
      { setSessionKey, countUsersByLastFmName } as never,
    );
    return { service, setUserLastFm, setSessionKey, cacheDelete, indexUser };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses the link when the linked-account count cannot be read', async () => {
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service, setUserLastFm, setSessionKey, indexUser } = makeService(async () => {
      throw new Error('P1001: Cannot reach database server');
    });

    const res = await service.confirmLogin('discord-1');

    // THE assertion. `.catch(() => 0)` made a database outage look like
    // "no accounts are linked", which is precisely the input that disables the
    // cap. Success here is the fail-open mutant.
    expect(res.status).not.toBe(LoginStatus.Success);
    expect(res.status).toBe(LoginStatus.GuardUnavailable);
    expect(setUserLastFm).not.toHaveBeenCalled();
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(indexUser).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  });

  it('keeps the pending token so the user can retry without restarting login', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service, cacheDelete } = makeService(async () => {
      throw new Error('P1001: Cannot reach database server');
    });

    await service.confirmLogin('discord-1');

    // The Last.fm session is still valid; only our own lookup failed. Dropping
    // the token would turn a transient blip into a full re-auth.
    expect(cacheDelete).not.toHaveBeenCalledWith('auth-pending:discord-1');
  });

  it('still links normally when the count is readable and under the cap', async () => {
    const { service, setUserLastFm, setSessionKey, indexUser } = makeService(async () => 2);

    const res = await service.confirmLogin('discord-1');

    expect(res.status).toBe(LoginStatus.Success);
    expect(setUserLastFm).toHaveBeenCalledWith('discord-1', 'SomeUser');
    expect(setSessionKey).toHaveBeenCalled();
    expect(indexUser).toHaveBeenCalled();
  });

  it('still refuses a sixth Discord row on the same Last.fm account', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const { service, setUserLastFm } = makeService(async () => 5);

    const res = await service.confirmLogin('discord-6');

    expect(res.status).toBe(LoginStatus.AltLimitExceeded);
    expect(setUserLastFm).not.toHaveBeenCalled();
  });
});
