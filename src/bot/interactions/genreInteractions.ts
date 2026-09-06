import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { GenreService, TopGenreItem, WhoKnowsGenreItem } from '@bot/services/genreService';
import { GenreBuilders } from '@bot/builders/genreBuilders';
import { UserService } from '@bot/services/userService';

export type GenreInteractionType = 'top' | 'info' | 'whoknows';

export interface CachedGenreQuery {
  type: GenreInteractionType;
  displayName?: string;
  genreName?: string;
  targetName?: string;
  periodDescription?: string;
  genres?: TopGenreItem[];
  artists?: { artistName: string; userPlaycount: number }[];
  whoknowsItems?: WhoKnowsGenreItem[];
  isServerView?: boolean;
  accentColor?: number | null;
  guildId?: string | null;
  serverName?: string;
  userId?: number;
  expiresAt: number;
}

const genreQueryCache = new Map<string, CachedGenreQuery>();

export function storeGenreQuery(
  cacheKey: string,
  data: Omit<CachedGenreQuery, 'expiresAt'>,
): void {
  genreQueryCache.set(cacheKey, {
    ...data,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  if (genreQueryCache.size > 200) {
    const now = Date.now();
    for (const [key, val] of genreQueryCache.entries()) {
      if (val.expiresAt < now) genreQueryCache.delete(key);
    }
  }
}

export function getCachedGenreQuery(cacheKey: string): CachedGenreQuery | undefined {
  const cached = genreQueryCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    genreQueryCache.delete(cacheKey);
    return undefined;
  }
  return cached;
}

@injectable()
export class GenreInteractions {
  constructor(
    @inject(GenreService) private readonly genreService: GenreService,
    @inject(UserService) private readonly userService: UserService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('genre:')) return;

    const parts = customId.split(':');
    // Pattern 1: genre:page:{action}:{type}:{cacheKey}:{page}:{callerDiscordUserId}
    // Pattern 2: genre:toggle:{user|server}:{cacheKey}:{page}:{callerDiscordUserId}

    if (parts[1] === 'toggle') {
      const targetView = parts[2]; // 'user' or 'server'
      const cacheKey = parts[3]!;
      const pageIndex = parseInt(parts[4]!, 10) || 0;
      const callerDiscordUserId = parts[5]!;

      if (interaction.user.id !== callerDiscordUserId) {
        await interaction.reply({
          content: 'Only the user who initiated the command can interact with these controls.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const cached = getCachedGenreQuery(cacheKey);
      if (!cached || !cached.genreName) {
        await interaction.reply({
          content: 'This interaction has expired. Please run the command again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const isServerView = targetView === 'server';
      let artists: { artistName: string; userPlaycount: number }[] = [];

      if (isServerView && cached.guildId) {
        artists = await this.genreService.getGuildArtistsForGenre(cached.guildId, cached.genreName);
      } else if (cached.userId) {
        artists = await this.genreService.getUserArtistsForGenre(cached.userId, cached.genreName);
      }

      cached.isServerView = isServerView;
      cached.artists = artists;

      const response = GenreBuilders.buildGenreArtistsResponse({
        genreName: cached.genreName,
        artists,
        isServerView,
        targetName: isServerView ? (cached.serverName ?? 'Server') : (cached.displayName ?? 'User'),
        pageIndex: 0,
        pageSize: 10,
        cacheKey,
        callerDiscordUserId,
        accentColor: cached.accentColor,
        guildId: cached.guildId,
      });

      await interaction.update(response.toMessagePayload());
      return;
    }

    if (parts[1] === 'page') {
      // genre:page:{action}:{type}:{cacheKey}:{page}:{callerDiscordUserId}
      const action = parts[2]; // 'first' | 'prev' | 'next' | 'last'
      const type = parts[3] as GenreInteractionType;
      const cacheKey = parts[4]!;
      const currentPage = parseInt(parts[5]!, 10);
      const callerDiscordUserId = parts[6]!;

      if (interaction.user.id !== callerDiscordUserId) {
        await interaction.reply({
          content: 'Only the user who initiated the command can interact with these controls.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const cached = getCachedGenreQuery(cacheKey);
      if (!cached) {
        await interaction.reply({
          content: 'This interaction has expired. Please run the command again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const pageSize = type === 'whoknows' ? 12 : 10;
      let totalItems = 0;
      if (type === 'top') totalItems = cached.genres?.length ?? 0;
      if (type === 'info') totalItems = cached.artists?.length ?? 0;
      if (type === 'whoknows') totalItems = cached.whoknowsItems?.length ?? 0;

      const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
      let targetPage = currentPage;

      if (action === 'first') targetPage = 0;
      else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
      else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
      else if (action === 'last') targetPage = totalPages - 1;

      let response;
      if (type === 'top') {
        response = GenreBuilders.buildTopGenresResponse({
          displayName: cached.displayName ?? 'User',
          genres: cached.genres ?? [],
          periodDescription: cached.periodDescription ?? 'all time',
          pageIndex: targetPage,
          pageSize,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
        });
      } else if (type === 'info') {
        response = GenreBuilders.buildGenreArtistsResponse({
          genreName: cached.genreName ?? 'Genre',
          artists: cached.artists ?? [],
          isServerView: cached.isServerView ?? false,
          targetName: cached.isServerView ? (cached.serverName ?? 'Server') : (cached.displayName ?? 'User'),
          pageIndex: targetPage,
          pageSize,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
          guildId: cached.guildId,
        });
      } else if (type === 'whoknows') {
        response = GenreBuilders.buildWhoKnowsGenreResponse({
          genreName: cached.genreName ?? 'Genre',
          serverName: cached.serverName ?? 'Server',
          items: cached.whoknowsItems ?? [],
          pageIndex: targetPage,
          pageSize,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
        });
      }

      if (response) {
        await interaction.update(response.toMessagePayload());
      }
    }
  }
}
