import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { LibrarySearchService, SearchTab } from '@bot/services/librarySearchService';
import { LibrarySearchBuilders } from '@bot/builders/librarySearchBuilders';
import { ColorService } from '@bot/services/colorService';
import { TtlStore } from '@bot/services/ttlStore';

interface CachedSearch {
  query: string;
  userId: number;
  expiresAt: number;
}

const searchStore = new TtlStore<CachedSearch>('session:library-search:', 30 * 60);

export function storeSearchQuery(cacheKey: string, query: string, userId: number): void {
  searchStore.set(cacheKey, {
    query,
    userId,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
}

export function getCachedSearchQuery(cacheKey: string): Promise<CachedSearch | undefined> {
  return searchStore.get(cacheKey);
}

@injectable()
export class LibrarySearchInteractions {
  constructor(
    @inject(LibrarySearchService) private readonly searchService: LibrarySearchService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('search:page:') && !customId.startsWith('search:tab:')) {
      return;
    }

    const parts = customId.split(':');
    if (parts.length < 5) return;

    const isPage = parts[1] === 'page';
    const cacheKey = parts[2]!;
    const tabNum = parseInt(parts[3]!, 10) as SearchTab;
    const pageNum = isPage ? parseInt(parts[4]!, 10) : 0;
    const targetDiscordUserId = isPage ? parts[5]! : parts[4]!;

    if (interaction.user.id !== targetDiscordUserId) {
      await interaction.reply({
        content: 'Only the user who initiated the search can interact with these controls.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cached = await getCachedSearchQuery(cacheKey);
    if (!cached) {
      await interaction.reply({
        content: 'This search session has expired. Please run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const allRows = await this.searchService.search(cached.userId, cached.query, tabNum);
    const accentColor = await this.colorService.getAccentColorAsync(targetDiscordUserId);

    const response = LibrarySearchBuilders.buildSearchResponse({
      query: cached.query,
      tab: tabNum,
      page: pageNum,
      allRows,
      cacheKey,
      targetDiscordUserId,
      accentColor,
    });

    await interaction.update(
      response.toMessagePayload() as Parameters<typeof interaction.update>[0],
    );
  }
}
