import { ConfigData } from '@bot/configurations/configData';
import { CacheService } from '@bot/services/system/cacheService';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { Logger } from '@domain/logger';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';

const PREFIX_CACHE_TTL_SECONDS = 300;

/**
 * The one read in this file that can actually fail.
 *
 * `CacheService.get` cannot throw: it holds an in-memory LRU and swallows Redis
 * failures as a cache MISS (`cacheService.ts`), and `CacheService.set` is the
 * same. `GuildRepository.getGuild` is the only call that reaches Prisma, and it
 * already returns `null` - a correct answer - for a guild with no row or an id
 * that is not a snowflake, so a malformed argument cannot be laundered into
 * "the database is down" from here. A throw reaching this is a query that could
 * not run, and it is the only thing that gets the raise.
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
      `Database unavailable in ${method} (${label}); refusing to invent a command prefix`,
    );
    throw new SourceUnavailableError(`prefixService.${method}:${label}`, err, 'Database unavailable');
  }
};

export class PrefixService {
  private readonly cache: CacheService;
  private readonly guildRepository: GuildRepository;
  private readonly defaultPrefix: string;

  constructor(
    cache: CacheService,
    guildRepository: GuildRepository,
  ) {
    this.cache = cache;
    this.guildRepository = guildRepository;
    this.defaultPrefix = ConfigData.Data.bot.prefix;
  }

  /**
   * The guild's command prefix.
   *
   * Raises `SourceUnavailableError` when the guild row cannot be read, and that
   * is the point. This used to `catch { return this.defaultPrefix }`, so a
   * database outage in a guild with a CUSTOM prefix (`!foo`) answered the user
   * with "Unknown command `.foo`" - a confident wrong answer at the very top of
   * the text path, naming a command the bot has and a prefix the user never
   * typed. The user could not tell a missing command from a missing prefix, and
   * neither could the log reader: nothing was logged, and the reply looked
   * exactly like a typo.
   *
   * There is no honest middle here. Any fallback string is a guess about how the
   * user chose to address the bot, and guessing is what produced the wrong
   * answer. So the failure is raised, and the text-command boundary
   * (`CommandHandler.handleMessage` -> `CommandDispatcher.handleCommandException`)
   * names it as an outage - the same wording every other source failure on that
   * path already uses.
   *
   * `guild?.prefix ?? this.defaultPrefix` is NOT a failure and stays: a guild
   * with no row genuinely uses the default prefix, and that is an answer.
   */
  public async getPrefix(guildId?: string | null): Promise<string> {
    if (!guildId) {
      return this.defaultPrefix;
    }
    // The cache read sits OUTSIDE `orDatabaseUnavailable` deliberately. It
    // cannot throw (`CacheService.get` returns null on a Redis failure, by
    // design), and a cached prefix is still a correct answer while the database
    // is down - so a warm cache keeps the whole text path working through an
    // outage. Only the database read below is allowed to raise.
    const cached = await this.cache.get<string>(`prefix:${guildId}`);
    if (cached) {
      return cached;
    }
    const guild = await orDatabaseUnavailable(
      'getPrefix',
      guildId,
      () => this.guildRepository.getGuild(guildId),
    );
    const prefix = guild?.prefix ?? this.defaultPrefix;
    await this.cache.set(`prefix:${guildId}`, prefix, PREFIX_CACHE_TTL_SECONDS);
    return prefix;
  }

  public async setPrefix(guildId: string, prefix: string): Promise<void> {
    await this.guildRepository.setPrefix(guildId, prefix);
    await this.cache.delete(`prefix:${guildId}`);
    await this.cache.delete(`guild:${guildId}`);
  }

  public getDefaultPrefix(): string {
    return this.defaultPrefix;
  }
}
