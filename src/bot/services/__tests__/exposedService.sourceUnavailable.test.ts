import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ExposedService } from '../exposedService';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * Every laundering site in `exposedService`, tested as a PAIR.
 *
 * WHY THE PAIR, AND WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE
 * -----------------------------------------------------------
 * `generateReport` returning `null` is not a neutral "no result". Both command
 * modules turn it into `ExposedBuilders.buildCleanRecordResponse`, which tells a
 * real, named person: *"We dug through the database, cross-referenced the genre
 * tables, and found **zero secret guilty pleasures**"* - and stamps the footer
 * `Status: Cleared`. So a dropped connection did not merely lose a card, it
 * produced a confident, cheerful, FABRICATED ACQUITTAL, complete with an
 * invented account of a search that never happened. That is the worst shape in
 * the whole launder report and the reason this file exists.
 *
 * Asserting only the raise would be satisfied by a method that always throws.
 * Asserting only the empty would be satisfied by the old code, which is exactly
 * the bug. So every site below is asserted twice:
 *
 *   (a) a source-unavailable failure VISIBLY propagates, and
 *   (b) a query that RAN and found nothing still returns the honest empty.
 *
 * (b) is the half that would break if the fix were "raise on everything".
 *
 * (a) uses a real `SourceUnavailableError` and asserts the SAME object comes
 * out, not merely something thrown - the wrappers deliberately re-throw rather
 * than re-wrap, so the label of the query that actually failed survives.
 *
 * Doubles are built fresh per test and passed positionally to the constructor
 * `(genreService, playRepo, prisma)`, read off the source. Nothing is spied on,
 * and the global container is never touched.
 */

const user = { userId: 1, discordUserId: '1', userNameLastFm: 'Moha' } as unknown as User;

/** The shape `genreService` raises: a deliberate, unanswerable source. */
const sourceDown = (method: string) =>
  new SourceUnavailableError(method, new Error('connection terminated'), 'Database unavailable');

const lastFmDown = (method: string) =>
  new SourceUnavailableError(method, new Error('502 from last.fm'), 'Last.fm unavailable', 'LastFmUnavailableError');

/** A genuine, unexpected failure - a bug, not an outage. Must still degrade. */
const boom = () => new TypeError('cannot read x of undefined');

// Every field optional, at BOTH levels: a test overrides one collaborator read
// and leaves its sibling at the default, so a partial double must be a legal
// argument to `build`.
interface Doubles {
  genreService?: Partial<{ getTopGenresForTopArtists: unknown; getGenresForArtist: unknown }>;
  playRepo?: Partial<{ getTopArtists: unknown }>;
  prisma?: {
    userArtist?: Partial<{ findMany: unknown }>;
    userPlay?: Partial<{ findMany: unknown; count: unknown }>;
  };
}

const build = (over: Doubles = {}) => {
  const genreService = {
    getTopGenresForTopArtists: vi.fn(async () => [{ genreName: 'hip-hop', userPlaycount: 900 }]),
    getGenresForArtist: vi.fn(async () => ['dance-pop', 'pop']),
    ...over.genreService,
  };
  const playRepo = {
    getTopArtists: vi.fn(async () => [
      { name: 'Travis Scott', playcount: 500 },
      { name: 'Playboi Carti', playcount: 450 },
      { name: 'Ken Carson', playcount: 300 },
    ]),
    ...over.playRepo,
  };
  const prisma = {
    userArtist: {
      findMany: vi.fn(async () => [{ name: 'Sabrina Carpenter', playcount: 15 }]),
      ...(over.prisma?.userArtist as object),
    },
    userPlay: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 3),
      ...(over.prisma?.userPlay as object),
    },
  };
  return { service: new ExposedService(genreService as never, playRepo as never, prisma as never), genreService, playRepo, prisma };
};

describe('ExposedService.generateReport - a source failure must not read as a clean record', () => {
  it('(a) propagates when the top-genres read raises, instead of returning the "cleared" null', async () => {
    const err = sourceDown('genreService.getTopGenresForTopArtists');
    const { service } = build({
      genreService: { getTopGenresForTopArtists: vi.fn(async () => { throw err; }) },
    });

    await expect(service.generateReport(user, 'Moha')).rejects.toBe(err);
  });

  it('(a) propagates when the per-candidate genre read raises', async () => {
    const err = lastFmDown('genreService.getGenresForArtist');
    const { service } = build({
      genreService: { getGenresForArtist: vi.fn(async () => { throw err; }) },
    });

    await expect(service.generateReport(user, 'Moha')).rejects.toBe(err);
  });

  it('(a) propagates when the recent-plays loop genre read raises', async () => {
    const err = lastFmDown('genreService.getGenresForArtist');
    const { service, genreService } = build({
      genreService: { getGenresForArtist: vi.fn(async () => { throw err; }) },
    });

    await expect(service.generateReport(user, 'Moha')).rejects.toBe(err);
    expect(genreService.getGenresForArtist).toHaveBeenCalled();
  });

  it('(a) wraps a raw database error from the candidate query, which is not a SourceUnavailableError', async () => {
    // `this.db.userArtist.findMany` throws a bare Prisma error, so a catch
    // narrowed with `isSourceUnavailable` alone would still render the false
    // all-clear. The read is wrapped for exactly this reason.
    const { service } = build({
      prisma: { userArtist: { findMany: vi.fn(async () => { throw new Error('P1001: cannot reach database server'); }) } },
    });

    const thrown = await service.generateReport(user, 'Moha').catch((e: unknown) => e);
    expect(isSourceUnavailable(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('exposedService:generateReport.userArtist.findMany');
  });

  it('(a) wraps a raw database error from the top-artists read', async () => {
    const { service } = build({
      playRepo: { getTopArtists: vi.fn(async () => { throw new Error('P1001'); }) },
    });

    const thrown = await service.generateReport(user, 'Moha').catch((e: unknown) => e);
    expect(isSourceUnavailable(thrown)).toBe(true);
  });

  it('(b) still returns the honest null when every read ran and found nothing', async () => {
    // The other half. A user with no top artists, no candidates and no
    // divergent plays genuinely has zero guilty pleasures, and that is a real
    // answer. A "fix" that raised here would have taken away a real verdict.
    const { service } = build({
      playRepo: { getTopArtists: vi.fn(async () => []) },
    });

    await expect(service.generateReport(user, 'Moha')).resolves.toBeNull();
  });

  it('(b) still returns the honest null when queries ran but the artist has no genres', async () => {
    const { service } = build({
      genreService: {
        getTopGenresForTopArtists: vi.fn(async () => []),
        getGenresForArtist: vi.fn(async () => []),
      },
    });

    await expect(service.generateReport(user, 'Moha')).resolves.toBeNull();
  });

  it('still produces a full report - real artists, real playcounts - when every read succeeds', async () => {
    const { service } = build();

    const report = await service.generateReport(user, 'Moha');
    expect(report).not.toBeNull();
    expect(report?.publicArtists).toContain('Travis Scott');
    expect(report?.guiltyPleasures?.[0]?.artistName).toBe('Sabrina Carpenter');
    expect(report?.guiltyPleasures?.[0]?.playcount).toBe(15);
  });

  it('still degrades to null on an unexpected bug, which is not a fact about the user', async () => {
    // Targets the UNWRAPPED genre read, so this pins the real distinction: a
    // deliberate source raise propagates, a plain bug still degrades. Retarget
    // this at a wrapped read and the test silently stops meaning anything.
    const { service } = build({
      genreService: { getGenresForArtist: vi.fn(async () => { throw boom(); }) },
    });

    await expect(service.generateReport(user, 'Moha')).resolves.toBeNull();
  });
});

describe('ExposedService.checkLiveNowPlayingAnomaly - no false accusation', () => {
  const anomalyArgs = ['guild-1', 'Hannah Montana', 'Best of Both Worlds'] as const;

  it('(a) propagates a deliberate raise rather than laundering it into "no anomaly"', async () => {
    const err = sourceDown('genreService.getTopGenresForTopArtists');
    const { service } = build({
      genreService: { getTopGenresForTopArtists: vi.fn(async () => { throw err; }) },
    });

    await expect(service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs)).rejects.toBe(err);
  });

  it('(a) propagates when the current artist genre read raises', async () => {
    const err = lastFmDown('genreService.getGenresForArtist');
    const { service } = build({
      genreService: { getGenresForArtist: vi.fn(async () => { throw err; }) },
    });

    await expect(service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs)).rejects.toBe(err);
  });

  it('(b) still returns null when the read ran and the artist is not an outlier', async () => {
    // Genuine "no anomaly": the current artist's genres carry no guilty tag.
    // The genre read is reached and answers - it does not raise.
    const { service, genreService } = build({
      genreService: { getGenresForArtist: vi.fn(async () => ['hip-hop']) },
    });

    await expect(service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs)).resolves.toBeNull();
    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Hannah Montana');
  });

  it('(b) still returns null on the honest-empty path when there are too few top artists', async () => {
    const { service } = build({
      playRepo: { getTopArtists: vi.fn(async () => [{ name: 'A', playcount: 1 }]) },
    });

    await expect(service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs)).resolves.toBeNull();
  });

  it('still fires the anomaly when every read succeeds', async () => {
    const { service } = build();

    const result = await service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs);
    expect(result).not.toBeNull();
    expect(result?.isAnomaly).toBe(true);
    expect(result?.matchedGenre).toBe('dance-pop');
  });

  it('does not burn the cooldown when a source fails, so a real anomaly is not suppressed for 7 days', async () => {
    // The cooldown maps are only written on success. If a failed read set them,
    // an outage would cost the user a genuine "Caught in 4K" for a week.
    // Proven by making the first call fail and the second succeed against the
    // SAME service instance - which is the only way a burnt cooldown would show.
    let failNext = true;
    const { service } = build({
      genreService: {
        getGenresForArtist: vi.fn(async () => {
          if (failNext) { failNext = false; throw lastFmDown('genreService.getGenresForArtist'); }
          return ['dance-pop', 'teen pop'];
        }),
      },
    });

    await expect(service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs)).rejects.toBeDefined();

    const second = await service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs);
    expect(second).not.toBeNull();
    expect(second?.isAnomaly).toBe(true);
  });

  it('still degrades to null on an unexpected bug', async () => {
    // Unwrapped read again, for the same reason as its twin in generateReport.
    const { service } = build({
      genreService: { getGenresForArtist: vi.fn(async () => { throw boom(); }) },
    });

    await expect(service.checkLiveNowPlayingAnomaly(user, ...anomalyArgs)).resolves.toBeNull();
  });
});
