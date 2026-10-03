import { injectable, inject } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { SourceUnavailableError } from '@domain/models/errors/sourceUnavailableError';
import { Logger } from '@domain/logging/logger';
import { MusicBrainzService } from '@bot/services/media/musicBrainzService';
import { CacheService } from '@bot/services/system/cacheService';

/**
 * The single place a raw-query failure becomes a caller-visible result.
 *
 * Same rule as `orDatabaseUnavailable` in `playHistoryService` and
 * `guildAdminService`: a query that returns NO ROWS is a real answer and stays
 * an empty array, but a query that THROWS is a failure and is raised rather than
 * returned. Six of the methods below end in `catch { return [] }`, and every one
 * of them feeds a card the user reads as a fact - a top-countries chart, a
 * `.country <name>` artist list, a `.whoknowscountry` table of real people. A
 * dropped connection therefore rendered as "you have no country data", which is
 * the failure the user cannot detect.
 *
 * There is no "not found" case to separate out the way Last.fm has one. All six
 * are aggregates over `user_artists`/`artists`, and an aggregate with no
 * matching rows succeeds with a shorter result - it never errors. So empty IS
 * the answer, and an error is always an error.
 *
 * Every caller sits behind a boundary that replies on a throw
 * (`commandHandler.ts:243`, `interactionHandler.ts:482`), so raising surfaces
 * as a visible error rather than a lie.
 */
const orDatabaseUnavailable = async <T>(
  method: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: `${method}:${label}`, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in ${method} (${label}); refusing to render the country answer as an empty list`,
    );
    throw new SourceUnavailableError(`countryService.${method}:${label}`, err, 'Database unavailable');
  }
};

/**
 * A guild id that is not a snowflake is a CALLER bug, not a source failure.
 *
 * This is separated out because `BigInt('not-a-snowflake')` throws a SyntaxError
 * from inside the query's `try`, and letting that reach `orDatabaseUnavailable`
 * would label a malformed argument as "Database unavailable" - a confident,
 * wrong diagnosis that sends whoever reads the log looking at Postgres instead
 * of at the caller. The query is never issued, so there is no outage to report.
 */
const toGuildId = (guildId: string): bigint | null => {
  try {
    return BigInt(guildId);
  } catch {
    Logger.warn(
      { guildId },
      'countryService received a guild id that is not a snowflake; no query was issued',
    );
    return null;
  }
};

export interface CountryInfo {
  Name: string;
  Code: string;
  Emoji: string;
  Unicode?: string;
  Image?: string;
  Aliases?: string[];
}

export interface TopCountryItem {
  countryName: string;
  countryCode: string;
  playcount: number;
  artistCount?: number;
  artists?: { name: string; playcount: number }[];
  /**
   * Coverage signal, present only when partial.
   *
   * `getTopCountriesForTopArtists` drops input artists with no mapped country,
   * and the card renders whatever is returned as the whole answer
   * ("N countries · M total scrobbles" with no coverage note), so a partial
   * aggregate presented bare is a confident undercount. When any contributing
   * artist (playcount > 0) had no country, every item carries `isPartial: true`
   * plus the dropped totals; when everything mapped the three keys are absent,
   * so a complete result keeps its exact existing shape.
   */
  isPartial?: boolean;
  unmappedArtistCount?: number;
  unmappedPlaycount?: number;
}

export interface GuildCountryItem {
  countryName: string;
  countryCode: string;
  totalPlaycount: number;
  listenerCount: number;
}

export interface WhoKnowsCountryItem {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  playcount: number;
}

@injectable()
export class CountryService {
  public readonly countries: CountryInfo[] = [];
  private readonly countryCodeMap = new Map<string, CountryInfo>();
  public readonly seedArtistCountryMap = new Map<string, string>();
  private readonly dbArtistCountryMap = new Map<string, string>();
  private dbPreloadPromise: Promise<void> | null = null;

  public getSeedCountry(artistName: string): string | undefined {
    return this.seedArtistCountryMap.get(artistName.toLowerCase().trim());
  }

  constructor(
    @inject(PrismaClient) private readonly prisma: PrismaClient,
    @inject(MusicBrainzService) private readonly musicBrainzService: MusicBrainzService,
    @inject(CacheService) private readonly cache: CacheService,
  ) {
    try {
      const candidates = [
        path.join(__dirname, '..', 'resources', 'countries.json'),
        path.join(process.cwd(), 'src', 'bot', 'resources', 'countries.json'),
        path.join(process.cwd(), 'dist', 'bot', 'resources', 'countries.json'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          this.countries = JSON.parse(raw);
          break;
        }
      }
    } catch (err) {
      // NOT a `SourceUnavailableError`, and the difference is deliberate. This is
      // a bundled resource file, not a query: if it is unreadable the build is
      // broken, and the same failure recurs on every single call rather than
      // being a transient outage. Raising here would throw out of a constructor
      // that `startup.ts` builds by hand, which takes the WHOLE bot down for a
      // country lookup - the `P3009` shape in AGENTS.md §10. So it is logged at
      // ERROR, which is the loudest honest thing available, and the service
      // degrades to "no country table" rather than refusing to boot.
      Logger.error(
        { err: (err as Error)?.message ?? String(err) },
        'countries.json could not be read; every country lookup will return undefined until this is fixed',
      );
      this.countries = [];
    }

    for (const c of this.countries) {
      this.countryCodeMap.set(c.Code.toUpperCase(), c);
    }

    this.reloadSeedMap();
    // CORRECT AS IS: a fire-and-forget preload kicked off from the CONSTRUCTOR.
    // Two things make the swallow right, and both are structural rather than
    // convenient.
    //
    // 1. This runs inside `startup.ts`'s hand-built graph. A throw here escapes a
    //    constructor and takes the WHOLE bot down for a country lookup - the
    //    `P3009` shape AGENTS.md §10 warns about - which is a strictly worse
    //    failure than a cold country cache.
    // 2. `ensureDbPreloaded` already handles its own failure, and handles it
    //    properly: it logs at ERROR and clears `dbPreloadPromise` so the next
    //    caller retries. This catch is a backstop against a throw from the
    //    logger itself, not the primary handling. See its own comment for why
    //    the degraded map is acceptable - the ladder in `getArtistCountry` still
    //    reaches the live database row and MusicBrainz.
    void this.ensureDbPreloaded().catch(() => undefined);
  }

  public reloadSeedMap(): void {
    try {
      const seedCandidates = [
        path.join(__dirname, '..', 'resources', 'artist_countries.json'),
        path.join(process.cwd(), 'src', 'bot', 'resources', 'artist_countries.json'),
        path.join(process.cwd(), 'dist', 'bot', 'resources', 'artist_countries.json'),
      ];
      for (const p of seedCandidates) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const data = JSON.parse(raw);
          for (const [k, v] of Object.entries(data)) {
            this.seedArtistCountryMap.set(k.toLowerCase(), (v as string).toUpperCase());
          }
          break;
        }
      }
    } catch (err) {
      // Correct as an empty result, and worth being precise about why: the seed
      // map is a CURATED CACHE, not the answer. When it is empty the ladder in
      // `getArtistCountry` still reaches the preloaded DB map, the cache and then
      // MusicBrainz, so an artist with a known country still gets one. What is
      // lost is the fast path, not the fact. Silently empty was the bug - the
      // symptom is a country chart that quietly omits every curated artist - so
      // this logs at ERROR and keeps degrading.
      Logger.error(
        { err: (err as Error)?.message ?? String(err) },
        'artist_countries.json could not be read; curated country lookups will fall through to the database and MusicBrainz',
      );
    }
  }

  public async ensureDbPreloaded(): Promise<void> {
    if (this.dbArtistCountryMap.size > 0) return;
    if (this.dbPreloadPromise) return this.dbPreloadPromise;
    this.dbPreloadPromise = (async () => {
      try {
        const rows = await this.prisma.artist.findMany({
          where: { countryCode: { not: null } },
          select: { name: true, countryCode: true },
        });
        for (const row of rows) {
          if (row.countryCode) {
            this.dbArtistCountryMap.set(row.name.toLowerCase(), row.countryCode.toUpperCase());
          }
        }
      } catch (err) {
        // Left as a resolved promise on purpose: `dbArtistCountryMap` is a
        // SNAPSHOT CACHE, so a failed preload is a cache miss, and the ladder in
        // `getArtistCountry` still reaches the live DB row and MusicBrainz below
        // it. Raising would make every artist lookup on a cold database fail
        // rather than degrade - a worse lie in the other direction.
        //
        // But the memoised promise is NOT kept, and that is the real bug here.
        // `dbPreloadPromise` used to survive a failure, so one dropped
        // connection during the constructor's fire-and-forget preload locked the
        // map empty for the whole process lifetime: every subsequent call short
        // circuited on the cached promise and never retried. A transient blip at
        // boot silently degraded every country chart for as long as the bot
        // stayed up. Clearing the latch lets the next caller retry, and the
        // ERROR log makes the first failure visible.
        Logger.error(
          { err: (err as Error)?.message ?? String(err) },
          'artist country preload failed; the map stays empty and lookups fall through to the live database and MusicBrainz',
        );
        this.dbPreloadPromise = null;
      }
    })();
    return this.dbPreloadPromise;
  }

  public static trimCountry(country: string): string {
    return country.toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
  }

  public getCountryByCode(code: string): CountryInfo | undefined {
    return this.countryCodeMap.get(code.toUpperCase());
  }

  public countryCodeToCountryName(code: string): string {
    return this.getCountryByCode(code)?.Name ?? code;
  }

  public searchCountry(countryValues: string): CountryInfo | undefined {
    if (!countryValues || !countryValues.trim()) return undefined;
    const q = CountryService.trimCountry(countryValues);
    return this.countries.find(c => {
      if (CountryService.trimCountry(c.Name) === q) return true;
      if (c.Code.toLowerCase() === q) return true;
      if (c.Emoji === countryValues.trim()) return true;
      if (c.Aliases?.some(a => CountryService.trimCountry(a) === q)) return true;
      return false;
    });
  }

  public searchCountries(countryValues: string): CountryInfo[] {
    if (!countryValues || !countryValues.trim()) return [];
    const q = CountryService.trimCountry(countryValues);
    return this.countries.filter(c => {
      const trimmedName = CountryService.trimCountry(c.Name);
      if (trimmedName === q || c.Code.toLowerCase() === q) return true;
      if (trimmedName.startsWith(q) || trimmedName.includes(q)) return true;
      if (c.Aliases?.some(a => CountryService.trimCountry(a).includes(q))) return true;
      return false;
    });
  }

  public async getArtistCountry(artistName: string): Promise<CountryInfo | undefined> {
    if (!artistName || !artistName.trim()) return undefined;
    const cleanName = artistName.trim().toLowerCase();

    // 1. Curated in-memory seed map
    const seedCode = this.seedArtistCountryMap.get(cleanName);
    if (seedCode) {
      return this.getCountryByCode(seedCode);
    }

    // 2. Preloaded DB artist country map
    await this.ensureDbPreloaded();
    const dbPreloadCode = this.dbArtistCountryMap.get(cleanName);
    if (dbPreloadCode) {
      return this.getCountryByCode(dbPreloadCode);
    }

    // 3. Cache check
    const cacheKey = `artist_country:${cleanName}`;
    const cachedCode = await this.cache.get<string>(cacheKey);
    if (cachedCode) {
      return this.getCountryByCode(cachedCode);
    }

    // 4. DB lookup (in case newly inserted)
    try {
      const dbArtist = await this.prisma.artist.findFirst({
        where: { name: { equals: artistName.trim(), mode: 'insensitive' } },
        select: { countryCode: true },
      });
      if (dbArtist?.countryCode) {
        const code = dbArtist.countryCode.toUpperCase();
        this.dbArtistCountryMap.set(cleanName, code);
        await this.cache.set(cacheKey, code, 86400);
        return this.getCountryByCode(code);
      }
    } catch (err) {
      // Correct as-is, and the ladder is the reason: this rung is a cache-warming
      // lookup for an artist the preloaded map has not seen, and rung 5 below is
      // MusicBrainz - a genuinely different source that can still answer. Raising
      // here would turn "our row is unreadable" into a failed artist card even
      // when rung 5 was about to produce the right country. A `Logger.debug` is
      // the honest weight for it (§3.10: expected-but-notable is DEBUG).
      Logger.debug(
        { artistName, err: (err as Error)?.message ?? String(err) },
        'countryService live artist row lookup failed; falling through to MusicBrainz',
      );
    }

    // 5. MusicBrainz lookup
    try {
      const mb = await this.musicBrainzService.getArtistData(artistName.trim());
      if (mb?.countryCode) {
        const code = mb.countryCode.toUpperCase();
        this.dbArtistCountryMap.set(cleanName, code);
        await this.cache.set(cacheKey, code, 86400);
        // Fire-and-forget write-back, and correctly so: the country is ALREADY in
        // hand from MusicBrainz and is about to be returned. Failing to persist
        // it costs a repeat MusicBrainz lookup next time, nothing more - so this
        // is the one place a swallowed rejection is genuinely correct, and the
        // `.catch` is also what keeps an unhandled rejection out of the process.
        this.prisma.artist.updateMany({
          where: { name: { equals: artistName.trim(), mode: 'insensitive' } },
          data: { countryCode: code },
        }).catch((writeErr: unknown) => {
          Logger.warn(
            { artistName, err: (writeErr as Error)?.message ?? String(writeErr) },
            'countryService could not persist the MusicBrainz country; the next lookup will ask again',
          );
          return undefined;
        });
        return this.getCountryByCode(code);
      }
    } catch (err) {
      // This one is NOT ignored, and the asymmetry with rung 4 is the point.
      // Rung 5 is the LAST rung: if MusicBrainz fails there is nothing left, so
      // `undefined` below is being returned for two different reasons - "this
      // artist genuinely has no country" and "we could not ask" - and the caller
      // cannot tell them apart. That is the same conflation this class of bug is
      // about, so it is at least logged. It is not raised because this method's
      // contract is an OPTIONAL field: `.country <artist>` renders a card with no
      // flag, which is a truthful "we do not know", and raising would fail a
      // whole card over a decoration.
      Logger.warn(
        { artistName, err: (err as Error)?.message ?? String(err) },
        'MusicBrainz country lookup failed; the artist will render with no country rather than a wrong one',
      );
    }

    return undefined;
  }

  public async getArtistInfoWithCountry(artistName: string): Promise<{
    country?: CountryInfo;
    spotifyImageUrl?: string;
  }> {
    const country = await this.getArtistCountry(artistName);
    const spotifyImageUrl = await orDatabaseUnavailable(
      'getArtistInfoWithCountry',
      'artist.spotifyImageUrl',
      async () => {
        const dbArtist = await this.prisma.artist.findFirst({
          where: { name: { equals: artistName.trim(), mode: 'insensitive' } },
          select: { spotifyImageUrl: true },
        });
        return dbArtist?.spotifyImageUrl ?? undefined;
      },
    );

    return { country, spotifyImageUrl };
  }

  public async getTopCountriesForTopArtists(
    topArtists: { name: string; playcount: number }[],
    addArtists = false,
  ): Promise<TopCountryItem[]> {
    if (!topArtists || topArtists.length === 0) return [];

    const artistNames = [...new Set(topArtists.map(a => a.name))];
    if (artistNames.length === 0) return [];

    await this.ensureDbPreloaded();

    const artistCountryMap = new Map<string, string>();
    const missing: string[] = [];

    for (const name of artistNames) {
      const lower = name.toLowerCase();
      const code = this.seedArtistCountryMap.get(lower) ?? this.dbArtistCountryMap.get(lower);
      if (code) {
        artistCountryMap.set(lower, code);
      } else {
        missing.push(name);
      }
    }

    // Asynchronously resolve top missing artists via MusicBrainz in the background without blocking the user response
    if (missing.length > 0) {
      setImmediate(async () => {
        for (const name of missing.slice(0, 5)) {
          try {
            const mb = await this.musicBrainzService.getArtistData(name);
            if (mb?.countryCode) {
              const code = mb.countryCode.toUpperCase();
              this.dbArtistCountryMap.set(name.toLowerCase(), code);
              await this.prisma.artist.updateMany({
                where: { name: { equals: name, mode: 'insensitive' } },
                data: { countryCode: code },
              });
            }
          } catch (err) {
            // Correct as-is. This runs on `setImmediate` AFTER the response has
            // already been produced - nothing the user is looking at depends on
            // it. It is a background enrichment that makes the NEXT request
            // faster, so a failure here cannot be the answer to anything, and
            // raising inside a detached callback would be an unhandled rejection
            // rather than a visible error. DEBUG is the right weight.
            Logger.debug(
              { artistName: name, err: (err as Error)?.message ?? String(err) },
              'background country enrichment failed; the next request will retry it',
            );
          }
        }
      });
    }

    // Aggregate playcounts and optionally group artists by country.
    //
    // Artists with no mapped country are dropped from the totals, which is only
    // honest if the result says so: the card presents the list as complete, so
    // the dropped artists and their plays ride along as a partial signal on the
    // existing result shape. A genuinely unknown artist (no country anywhere) is
    // still dropped rather than raising - there is no country to show - but the
    // caller can now tell "everything mapped" (keys absent) from "some plays
    // had no country" (`isPartial: true`).
    const unmappedPlays = new Map<string, number>();
    for (const item of topArtists) {
      if (artistCountryMap.has(item.name.toLowerCase()) || item.playcount <= 0) continue;
      const key = item.name.toLowerCase();
      unmappedPlays.set(key, (unmappedPlays.get(key) ?? 0) + item.playcount);
    }
    const unmappedArtistCount = unmappedPlays.size;
    const unmappedPlaycount = [...unmappedPlays.values()].reduce((sum, n) => sum + n, 0);
    const isPartial = unmappedArtistCount > 0;

    const countryPlaycounts = new Map<string, number>();
    const countryArtists = new Map<string, { name: string; playcount: number }[]>();

    for (const item of topArtists) {
      const code = artistCountryMap.get(item.name.toLowerCase());
      if (code && item.playcount > 0) {
        const current = countryPlaycounts.get(code) ?? 0;
        countryPlaycounts.set(code, current + item.playcount);

        if (addArtists) {
          if (!countryArtists.has(code)) countryArtists.set(code, []);
          countryArtists.get(code)!.push({ name: item.name, playcount: item.playcount });
        }
      }
    }

    const results: TopCountryItem[] = [];
    for (const [code, playcount] of countryPlaycounts.entries()) {
      const countryInfo = this.getCountryByCode(code);
      const countryName = countryInfo?.Name ?? code;
      const artists = countryArtists.get(code)?.sort((a, b) => b.playcount - a.playcount);

      results.push({
        countryName,
        countryCode: code,
        playcount,
        artistCount: artists ? artists.length : undefined,
        artists: addArtists ? (artists ?? []) : undefined,
        ...(isPartial ? { isPartial: true, unmappedArtistCount, unmappedPlaycount } : {}),
      });
    }

    // Sort by artist count descending if addArtists, otherwise playcount descending
    results.sort((a, b) => (addArtists ? (b.artists?.length ?? 0) - (a.artists?.length ?? 0) : b.playcount - a.playcount));
    return results;
  }

  public async getUserArtistsTop(userId: number, limit = 10000): Promise<{ name: string; playcount: number }[]> {
    return orDatabaseUnavailable('getUserArtistsTop', 'userArtist.findMany', () =>
      this.prisma.userArtist.findMany({
        where: { userId },
        select: { name: true, playcount: true },
        orderBy: { playcount: 'desc' },
        take: limit,
      }),
    );
  }

  public async getUserTopCountriesAllTime(userId: number, limit = 250): Promise<TopCountryItem[]> {
    this.reloadSeedMap();
    // Two sources, and the first one is a real aggregate over `user_artists`
    // rather than an enrichment - if it fails the chart is not "empty", it is
    // unknown, and `.topcountries` then renders "you have no country data".
    const userArtists = await this.getUserArtistsTop(userId, 10000);
    if (userArtists.length > 0) {
      const aggregated = await this.getTopCountriesForTopArtists(userArtists, true);
      if (aggregated.length > 0) {
        // The slice keeps the partial signal on the items: a partial aggregate
        // stays visibly partial, it is never trimmed into a complete-looking one.
        return aggregated.slice(0, limit);
      }
    }

    // Only the raw fallback is wrapped, and deliberately not in a method-wide
    // `try`. A method-wide catch would also swallow the `SourceUnavailableError`
    // raised just above and return `[]` for it, re-creating the exact bug
    // through the back door.
    const rows = await orDatabaseUnavailable(
      'getUserTopCountriesAllTime',
      'userCountryTotals',
      () => this.prisma.$queryRaw<Array<{ countryCode: string; playcount: bigint; artistCount: bigint }>>`
        SELECT a.country_code AS "countryCode",
               SUM(ua.playcount)::bigint AS "playcount",
               COUNT(DISTINCT ua.artist_id)::bigint AS "artistCount"
        FROM user_artists ua
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId}
          AND ua.artist_id IS NOT NULL
          AND a.country_code IS NOT NULL
        GROUP BY a.country_code
        ORDER BY "playcount" DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      countryName: this.countryCodeToCountryName(r.countryCode),
      countryCode: r.countryCode.toUpperCase(),
      playcount: Number(r.playcount),
      artistCount: Number(r.artistCount),
    }));
  }

  public async getUserArtistsForCountry(
    userId: number,
    countryCode: string,
    limit = 100,
  ): Promise<{ name: string; playcount: number }[]> {
    const rows = await orDatabaseUnavailable(
      'getUserArtistsForCountry',
      'userArtistsInCountry',
      () => this.prisma.$queryRaw<Array<{ name: string; playcount: bigint }>>`
        SELECT ua.name AS "name", ua.playcount::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId}
          AND ua.artist_id IS NOT NULL
          AND LOWER(a.country_code) = LOWER(${countryCode.trim()})
        ORDER BY ua.playcount DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      name: r.name,
      playcount: Number(r.playcount),
    }));
  }

  public async getGuildTopCountriesAllTime(guildId: string, limit = 100): Promise<GuildCountryItem[]> {
    const gIdBigInt = toGuildId(guildId);
    if (gIdBigInt === null) return [];

    const rows = await orDatabaseUnavailable(
      'getGuildTopCountriesAllTime',
      'guildCountryTotals',
      () => this.prisma.$queryRaw<Array<{ countryCode: string; totalPlaycount: bigint; listenerCount: bigint }>>`
        SELECT a.country_code AS "countryCode",
               SUM(ua.playcount)::bigint AS "totalPlaycount",
               COUNT(DISTINCT ua.user_id)::bigint AS "listenerCount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        INNER JOIN users u ON u.user_id = ua.user_id AND u.privacy_level <> 'Hide' AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND a.country_code IS NOT NULL
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY a.country_code
        ORDER BY "listenerCount" DESC, "totalPlaycount" DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      countryName: this.countryCodeToCountryName(r.countryCode),
      countryCode: r.countryCode.toUpperCase(),
      totalPlaycount: Number(r.totalPlaycount),
      listenerCount: Number(r.listenerCount),
    }));
  }

  public async getGuildArtistsForCountry(
    guildId: string,
    countryCode: string,
    limit = 50,
  ): Promise<{ name: string; playcount: number }[]> {
    const gIdBigInt = toGuildId(guildId);
    if (gIdBigInt === null) return [];

    const rows = await orDatabaseUnavailable(
      'getGuildArtistsForCountry',
      'guildArtistsInCountry',
      () => this.prisma.$queryRaw<Array<{ name: string; playcount: bigint }>>`
        SELECT ua.name AS "name", SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        INNER JOIN users u ON u.user_id = ua.user_id AND u.privacy_level <> 'Hide' AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND LOWER(a.country_code) = LOWER(${countryCode.trim()})
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY ua.name
        ORDER BY "playcount" DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      name: r.name,
      playcount: Number(r.playcount),
    }));
  }

  public async getGuildUsersForCountry(guildId: string, countryCode: string): Promise<WhoKnowsCountryItem[]> {
    const gIdBigInt = toGuildId(guildId);
    if (gIdBigInt === null) return [];

    const rows = await orDatabaseUnavailable(
      'getGuildUsersForCountry',
      'guildUsersInCountry',
      () => this.prisma.$queryRaw<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>`
        SELECT ua.user_id AS "userId",
               u.discord_user_id AS "discordUserId",
               u.user_name_last_fm AS "userNameLastFm",
               SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN users u ON u.user_id = ua.user_id
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND LOWER(a.country_code) = LOWER(${countryCode.trim()})
          AND u.privacy_level <> 'Hide'
          AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY ua.user_id, u.discord_user_id, u.user_name_last_fm
        ORDER BY "playcount" DESC
        LIMIT 50
      `,
    );

    return rows.map(r => ({
      userId: r.userId,
      discordUserId: r.discordUserId.toString(),
      userNameLastFm: r.userNameLastFm,
      playcount: Number(r.playcount),
    }));
  }
}
