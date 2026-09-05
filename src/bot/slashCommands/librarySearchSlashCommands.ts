import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { LibrarySearchService, SearchTab } from '@bot/services/librarySearchService';
import { LibrarySearchBuilders } from '@bot/builders/librarySearchBuilders';
import { storeSearchQuery } from '@bot/interactions/librarySearchInteractions';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
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
          .setName('search')
          .setDescription('Search through your stored Last.fm library (tracks, albums, artists, scrobbles).')
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

    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

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
