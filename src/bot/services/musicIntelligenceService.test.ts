import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicIntelligenceService } from './musicIntelligenceService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logger';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';

describe('MusicIntelligenceService', () => {
  let service: MusicIntelligenceService;
  let mockPrisma: any;
  let mockCountryService: any;
  // Built but never injected - see the note in the quality review.
  let _mockLastfmRepo: Partial<ILastfmRepository>;
  // Built but never injected - see the note in the quality review.
  let _mockGenreService: any;

  beforeEach(() => {
    _mockLastfmRepo = {
      loveTrack: vi.fn().mockResolvedValue(true),
      unloveTrack: vi.fn().mockResolvedValue(true),
      getLovedTracks: vi.fn().mockResolvedValue({
        tracks: [
          { name: 'Paranoid Android', artistName: 'Radiohead', playcount: 1, url: 'https://last.fm/track1' },
          { name: 'Heroes', artistName: 'David Bowie', playcount: 1, url: 'https://last.fm/track2' },
        ],
        total: 2,
      }),
      scrobbleTrack: vi.fn().mockResolvedValue(true),
    };

    mockPrisma = {
      $queryRawUnsafe: vi.fn(),
      artist: {
        findMany: vi.fn(),
      },
      guildUser: {
        findMany: vi.fn(),
      },
      userArtist: {
        findMany: vi.fn(),
      },
    };

    _mockGenreService = {
      getTopGenresForTopArtists: vi.fn().mockResolvedValue([
        { genreName: 'rock', userPlaycount: 100 },
        { genreName: 'alternative', userPlaycount: 80 },
      ]),
    };

    mockCountryService = {
      getTopCountriesForTopArtists: vi.fn().mockResolvedValue([
        { countryCode: 'gb', countryName: 'United Kingdom', playcount: 120 },
      ]),
    };

    service = new MusicIntelligenceService(mockPrisma as PrismaClient, mockCountryService);
  });

  // The failure tests below spy on `Logger.error`. A spy left in place on a shared
  // module singleton is the exact bug class this repo has been bitten by before
  // (35 failures once, 12 more later): `mockRestore()` can leave an own property
  // set to `undefined` and every later test then dies against it. Restore after
  // EVERY test rather than per-test, so a new failure test cannot forget.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getListeningGaps', () => {
    it('returns artist gaps correctly from raw SQL results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          name: 'The Cure',
          resume_date: new Date('2024-05-01T00:00:00Z'),
          prev_played: new Date('2023-01-01T00:00:00Z'),
          gap_days: 486.2,
          total_plays: 350n,
        },
      ]);

      const gaps = await service.getListeningGaps(1, 'artist', 90);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.name).toBe('The Cure');
      expect(gaps[0]!.gapDays).toBe(486);
      expect(gaps[0]!.totalPlays).toBe(350);
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('returns album gaps correctly from raw SQL results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          name: 'Disintegration',
          artist_name: 'The Cure',
          resume_date: new Date('2024-05-01T00:00:00Z'),
          prev_played: new Date('2023-01-01T00:00:00Z'),
          gap_days: 486,
          total_plays: 80n,
        },
      ]);

      const gaps = await service.getListeningGaps(1, 'album', 90);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.name).toBe('Disintegration');
      expect(gaps[0]!.artistName).toBe('The Cure');
    });

    it('returns track gaps correctly from raw SQL results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          name: 'Pictures of You',
          artist_name: 'The Cure',
          resume_date: new Date('2024-05-01T00:00:00Z'),
          prev_played: new Date('2023-01-01T00:00:00Z'),
          gap_days: 486,
          total_plays: 40n,
        },
      ]);

      const gaps = await service.getListeningGaps(1, 'track', 90);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.name).toBe('Pictures of You');
      expect(gaps[0]!.artistName).toBe('The Cure');
    });
  });

  describe('getDiscoveries', () => {
    it('returns newly discovered artists in the timeframe', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          artist_name: 'Fontaines D.C.',
          first_play: new Date('2024-02-15T00:00:00Z'),
          playcount: 142n,
        },
        {
          artist_name: 'Geese',
          first_play: new Date('2024-03-10T00:00:00Z'),
          playcount: 65n,
        },
      ]);

      const start = new Date('2024-01-01');
      const end = new Date('2024-04-01');
      const discoveries = await service.getDiscoveries(1, start, end);

      expect(discoveries).toHaveLength(2);
      expect(discoveries[0]!.artistName).toBe('Fontaines D.C.');
      expect(discoveries[0]!.playcount).toBe(142);
      expect(discoveries[1]!.artistName).toBe('Geese');
    });
  });

  describe('getIceberg', () => {
    it('distributes artists into 5 tiers based on popularity', async () => {
      mockPrisma.artist.findMany.mockResolvedValueOnce([
        { name: 'Taylor Swift', popularity: 95 },
        { name: 'Deftones', popularity: 72 },
        { name: 'Sweet Trip', popularity: 48 },
        { name: 'Parannoul', popularity: 28 },
        { name: 'Panchiko', popularity: 12 },
      ]);

      const topArtists = [
        { name: 'Taylor Swift', playcount: 500 },
        { name: 'Deftones', playcount: 300 },
        { name: 'Sweet Trip', playcount: 200 },
        { name: 'Parannoul', playcount: 150 },
        { name: 'Panchiko', playcount: 100 },
      ];

      const iceberg = await service.getIceberg(1, topArtists, 'Alex', 'alex_lfm', 'All time');

      expect(iceberg.tiers).toHaveLength(5);
      expect(iceberg.tiers[0]!.artists[0]!.name).toBe('Taylor Swift'); // Tier 1: 95
      expect(iceberg.tiers[1]!.artists[0]!.name).toBe('Deftones');     // Tier 2: 72
      expect(iceberg.tiers[2]!.artists[0]!.name).toBe('Sweet Trip');   // Tier 3: 48
      expect(iceberg.tiers[3]!.artists[0]!.name).toBe('Parannoul');    // Tier 4: 28
      expect(iceberg.tiers[4]!.artists[0]!.name).toBe('Panchiko');     // Tier 5: 12
    });
  });

  describe('getGuildAffinity', () => {
    it('computes taste similarity between target user and guild members', async () => {
      mockPrisma.guildUser.findMany.mockResolvedValueOnce([
        {
          userId: 2,
          guildId: 1000n,
          user: {
            userId: 2,
            discordUserId: 222222222222222222n,
            userNameLastFm: 'charlie_lfm',
          },
        },
      ]);

      mockPrisma.userArtist.findMany
        .mockResolvedValueOnce([
          { name: 'Radiohead', playcount: 500 },
          { name: 'Slowdive', playcount: 300 },
          { name: 'The Cure', playcount: 200 },
        ])
        .mockResolvedValueOnce([
          { userId: 2, name: 'Radiohead', playcount: 400 },
          { userId: 2, name: 'Slowdive', playcount: 250 },
        ]);

      const affinity = await service.getGuildAffinity(
        '1000',
        1,
        'Alex',
        'alex_lfm',
        'Music Server',
      );

      expect(affinity.neighbors).toHaveLength(1);
      expect(affinity.neighbors[0]!.userNameLastFm).toBe('charlie_lfm');
      expect(affinity.neighbors[0]!.totalPercentage).toBeGreaterThan(0);
      expect(affinity.neighbors[0]!.sharedArtists).toContain('Radiohead');
      expect(affinity.neighbors[0]!.sharedArtists).toContain('Slowdive');
    });
  });

  /**
   * A1 — "no query is silent".
   *
   * Every read in this file ended in `.catch(() => [])`, so a dropped connection
   * and a user who has never pressed play were the same value, and both cards
   * said something confident about it. Each site is now tested as a PAIR:
   *
   *   1. a query that THROWS raises `SourceUnavailableError` after `Logger.error`
   *   2. a query that RAN and found nothing still returns the empty answer
   *
   * Asserting only (1) cannot tell the fix from a method that always throws, and
   * asserting only (2) cannot tell the fix from the bug. Both directions are
   * pinned, for the same reason `guildAdminService` pins its genuine-zeros case.
   */
  describe('A1: a query that cannot run must not render as one that found nothing', () => {
    const DB_DOWN = () => new Error('Connection terminated unexpectedly');

    /** Silences and captures the mandatory ERROR so tests do not spam the log. */
    const captureErrorLog = () => vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    /**
     * Answers EVERY read `getGuildAffinity` makes, so a test can break exactly one.
     *
     * The two `userArtist.findMany` calls are told apart by their own argument —
     * the target's is `{ userId: <number> }`, the guild's is `{ userId: { in: [...] } }`.
     * Keying on that is what makes "break the SECOND read only" expressible
     * without depending on call ordering, which is a fragile thing to assert on.
     */
    const answerEveryAffinityRead = (
      breakRead?: 'guildUsers' | 'targetArtists' | 'guildArtists' | 'enrichment',
    ): void => {
      mockPrisma.guildUser.findMany.mockImplementation(() =>
        breakRead === 'guildUsers' ? Promise.reject(DB_DOWN()) : Promise.resolve([
          {
            userId: 2,
            guildId: 1000n,
            user: { userId: 2, discordUserId: 222222222222222222n, userNameLastFm: 'charlie_lfm' },
          },
        ]),
      );
      mockPrisma.userArtist.findMany.mockImplementation((args: { where?: { userId?: unknown } }) => {
        const target = typeof args?.where?.userId === 'number';
        if (target && breakRead === 'targetArtists') return Promise.reject(DB_DOWN());
        if (!target && breakRead === 'guildArtists') return Promise.reject(DB_DOWN());
        return Promise.resolve(
          target
            ? [{ name: 'Radiohead', playcount: 500 }]
            : [{ userId: 2, name: 'Radiohead', playcount: 400 }],
        );
      });
      mockPrisma.artist.findMany.mockImplementation(() =>
        breakRead === 'enrichment' ? Promise.reject(DB_DOWN()) : Promise.resolve([]),
      );
    };

    const affinityArgs = ['1000', 1, 'Alex', 'alex_lfm', 'Music Server'] as const;

    // ------------------------------------------------------------- gaps ------

    it.each(['artist', 'album', 'track'] as const)(
      'raises instead of reporting "no %s hiatuses found" when the query fails',
      async (entityType) => {
        const error = captureErrorLog();
        mockPrisma.$queryRawUnsafe.mockRejectedValue(DB_DOWN());

        const thrown = await service.getListeningGaps(1, entityType, 90).catch((e: unknown) => e);

        expect(isSourceUnavailable(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(`getListeningGaps:${entityType}`);
        // The rule's first half: it must say so, not merely stop returning a lie.
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({ query: `musicIntelligenceService:getListeningGaps:${entityType}` }),
          expect.stringContaining('refusing to render the failure as a real answer'),
        );
      },
    );

    it.each(['artist', 'album', 'track'] as const)(
      'still returns an empty %s list when the query RAN and found no gap',
      async (entityType) => {
        captureErrorLog();
        mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
        await expect(service.getListeningGaps(1, entityType, 90)).resolves.toEqual([]);
      },
    );

    // -------------------------------------------------------- discoveries ----

    it('raises instead of reporting "you discovered nothing" when the query fails', async () => {
      const error = captureErrorLog();
      mockPrisma.$queryRawUnsafe.mockRejectedValue(DB_DOWN());

      const thrown = await service
        .getDiscoveries(1, new Date('2024-01-01'), new Date('2024-04-01'))
        .catch((e: unknown) => e);

      expect(isSourceUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('getDiscoveries');
      expect(error).toHaveBeenCalled();
    });

    it('still returns an empty discoveries list when the query RAN and found none', async () => {
      captureErrorLog();
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      await expect(
        service.getDiscoveries(1, new Date('2024-01-01'), new Date('2024-04-01')),
      ).resolves.toEqual([]);
    });

    // ----------------------------------------------------------- iceberg -----

    it('raises instead of FABRICATING a popularity for every artist when the query fails', async () => {
      // The worst of the nine. `artist.findMany` failing emptied the popularity
      // map, `hasDbPopularity` went false, and the RANK-RATIO FALLBACK then
      // invented a popularity score per artist out of playcount position — so an
      // outage rendered a complete, confident, entirely fictional five-tier
      // iceberg. Asserting the throw is the fix; asserting no tiers come back is
      // what stops the fallback from quietly re-entering through the back door.
      const error = captureErrorLog();
      mockPrisma.artist.findMany.mockRejectedValue(DB_DOWN());

      const topArtists = [
        { name: 'Taylor Swift', playcount: 500 },
        { name: 'Panchiko', playcount: 100 },
      ];
      const thrown = await service
        .getIceberg(1, topArtists, 'Alex', 'alex_lfm', 'All time')
        .catch((e: unknown) => e);

      expect(isSourceUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('getIceberg:artistPopularity');
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'musicIntelligenceService:getIceberg:artistPopularity' }),
        expect.any(String),
      );
    });

    it('KEEPS the rank-ratio fallback when the query ran and simply has no popularity', async () => {
      // The half that must NOT change. The fallback is honest when the query
      // ANSWERED and the answer was "these artists are unscored". Distinguishing
      // that from a throw is the entire point of the fix, so a "fix" that also
      // raised on empty would break a real feature and this test is what catches it.
      captureErrorLog();
      mockPrisma.artist.findMany.mockResolvedValue([]);

      const topArtists = [
        { name: 'Taylor Swift', playcount: 500 },
        { name: 'Panchiko', playcount: 100 },
      ];
      const iceberg = await service.getIceberg(1, topArtists, 'Alex', 'alex_lfm', 'All time');

      expect(iceberg.tiers).toHaveLength(5);
      const placed = iceberg.tiers.flatMap((t) => t.artists);
      expect(placed).toHaveLength(2);
      // Rank-derived: the top artist scores far above the bottom one, so the
      // fallback really ran rather than every artist landing in one tier.
      expect(placed[0]!.popularity!).toBeGreaterThan(placed[1]!.popularity!);
    });

    // ----------------------------------------------------------- affinity ----

    it('raises instead of claiming nobody in the server has a similar taste when the candidate list fails', async () => {
      const error = captureErrorLog();
      answerEveryAffinityRead('guildUsers');

      const thrown = await service.getGuildAffinity(...affinityArgs).catch((e: unknown) => e);

      expect(isSourceUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('getGuildAffinity:guildUsers');
      expect(error).toHaveBeenCalled();
    });

    it('raises instead of listing every neighbour at 0% when the TARGET user read fails', async () => {
      // The partial-success trap, and the reason this file could not be triaged
      // by shape alone. An empty target list does NOT render an empty table — it
      // empties `targetArtistMap`, which zeroes `artistScore` and therefore
      // `totalPercentage` for EVERY neighbour. The user gets a full affinity
      // table of real people, every number wrong, sorted by those wrong numbers.
      // Identical in shape to `guildAdminService.getMembersOverview`.
      const error = captureErrorLog();
      answerEveryAffinityRead('targetArtists');

      const thrown = await service.getGuildAffinity(...affinityArgs).catch((e: unknown) => e);

      expect(isSourceUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('getGuildAffinity:targetArtists');
      expect(error).toHaveBeenCalled();
    });

    it('raises instead of collapsing the neighbour list when the GUILD artist read fails', async () => {
      const error = captureErrorLog();
      answerEveryAffinityRead('guildArtists');

      const thrown = await service.getGuildAffinity(...affinityArgs).catch((e: unknown) => e);

      expect(isSourceUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('getGuildAffinity:guildArtists');
      expect(error).toHaveBeenCalled();
    });

    it('raises instead of printing 0% genres and 0% countries for a real table when the enrichment fails', async () => {
      // `artistPercentage` is real at this point and only the genre/country
      // columns depend on the failed read, which is what makes it insidious: the
      // table looks trustworthy right up to the columns that were never measured.
      const error = captureErrorLog();
      answerEveryAffinityRead('enrichment');

      const thrown = await service.getGuildAffinity(...affinityArgs).catch((e: unknown) => e);

      expect(isSourceUnavailable(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('getGuildAffinity:artistEnrichment');
      expect(error).toHaveBeenCalled();
    });

    it('still answers "no neighbours" when the server genuinely has no other indexed member', async () => {
      // The honest empty. The builder renders "*Could not find indexed users with
      // a similar music taste in this server*", and for THIS input that sentence
      // is true — which is exactly why an outage rendering the same sentence is
      // indistinguishable from it and had to be separated.
      const error = captureErrorLog();
      mockPrisma.guildUser.findMany.mockResolvedValue([]);

      const affinity = await service.getGuildAffinity(...affinityArgs);

      expect(affinity.neighbors).toEqual([]);
      expect(affinity.totalGuildUsers).toBe(0);
      expect(error).not.toHaveBeenCalled();
      // The later reads must not even be attempted once the answer is known.
      expect(mockPrisma.userArtist.findMany).not.toHaveBeenCalled();
    });

    it('issues no query at all for a guild id that is not a snowflake', async () => {
      // `BigInt('not-a-snowflake')` throws a SyntaxError. That is a CALLER bug,
      // not an outage, and laundering it into "Database unavailable" would send
      // whoever reads the log to look at Postgres instead of at the caller.
      const error = captureErrorLog();

      const affinity = await service.getGuildAffinity(
        'not-a-snowflake', 1, 'Alex', 'alex_lfm', 'Music Server',
      );

      expect(affinity.neighbors).toEqual([]);
      expect(mockPrisma.guildUser.findMany).not.toHaveBeenCalled();
      // NOT an ERROR: nothing failed, there was simply nothing to ask.
      expect(error).not.toHaveBeenCalled();
    });
  });
});
