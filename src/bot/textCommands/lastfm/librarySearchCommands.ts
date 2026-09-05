import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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
export class LibrarySearchCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(LibrarySearchService) private readonly searchService: LibrarySearchService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        name: 'search',
        aliases: ['sr', 'find'],
        executeAsync: (context, args) => this.searchAsync(context, args?.join(' ') ?? ''),
      },
    ];
  }

  private async searchAsync(context: ContextModel, rawQuery: string): Promise<ResponseModel> {
    const query = rawQuery.trim();
    if (!query) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please provide a search query, e.g. \`${context.prefix}search daft punk\`.`,
      );
    }

    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
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
