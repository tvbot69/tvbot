import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';
import { UserService } from '@bot/services/user/userService';
import { LibrarySearchService, SearchTab } from '@bot/services/library/librarySearchService';
import { LibrarySearchBuilders } from '@bot/builders/library/librarySearchBuilders';
import { storeSearchQuery } from '@bot/interactions/library/librarySearchInteractions';
import { ColorService } from '@bot/services/system/colorService';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';

@injectable()
export class LibrarySearchSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(LibrarySearchService) private readonly searchService: LibrarySearchService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('searchdb')
          .setDescription('Search your stored Last.fm library. Text twin: .librarysearch')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Query to search for').setRequired(true),
          ),
        executeAsync: (context) => {
          const query = context.interaction?.options.getString('query') ?? '';
          return this.searchSlashAsync(context, query);
        },
      },
    ];
  }

  private async searchSlashAsync(context: ContextModel, rawQuery: string): Promise<ResponseModel> {
    const query = rawQuery.trim();
    if (!query) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        'Please provide a search query.',
      );
    }

    const linked = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if (linked instanceof ResponseModel) return linked;
    const callerUser = linked;

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeSearchQuery(cacheKey, query, callerUser.userId);

    const allRows = await this.searchService.search(callerUser.userId, query, SearchTab.Tracks);
    const accentColor = await this.colorService.getAccentColorAsync(context.discordUserId);

    return LibrarySearchBuilders.buildSearchResponse({
      query,
      tab: SearchTab.Tracks,
      page: 0,
      allRows,
      cacheKey,
      targetDiscordUserId: context.discordUserId,
      accentColor,
    });
  }
}
