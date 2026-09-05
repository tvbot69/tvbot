import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { AlbumBuilders } from '@bot/builders/albumBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { AlbumService } from '@bot/services/albumService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

export class AlbumCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly userService: UserService;
  private readonly albumService: AlbumService;
  private readonly updateService: UpdateService;

  constructor(
    userService: UserService,
    albumService: AlbumService,
    updateService: UpdateService,
  ) {
    this.userService = userService;
    this.albumService = albumService;
    this.updateService = updateService;
    this.commands = [
      {
        name: 'cover',
        aliases: ['co', 'abc', 'abco', 'albumcover'],
        executeAsync: (context, args) => this.coverAsync(context, args),
      },
      {
        name: 'album',
        aliases: ['ab', 'alb', 'albuminfo', 'abi'],
        executeAsync: (context, args) => this.albumAsync(context, args),
      },
      {
        name: 'albumtracks',
        aliases: ['abt', 'tracks', 'albumtrack', 'atracks'],
        executeAsync: (context, args) => this.albumTracksAsync(context, args),
      },
    ];
  }

  private async coverAsync(context: ContextModel, rawArgs: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const searchValue = rawArgs.join(' ').trim();
    const result = await this.albumService.searchAlbum(
      searchValue || null,
      user,
      context.guildId,
    );

    if (!result) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        searchValue
          ? `Could not find any album matching \`${searchValue}\`.`
          : 'Could not find any currently playing or recent album for your account.',
      );
    }

    const requesterName = context.message?.author.displayName ?? user.userNameLastFm;
    const accentColor = context.accentColor;

    return AlbumBuilders.buildCoverResponse(result, user, requesterName, accentColor);
  }

  private async albumAsync(context: ContextModel, rawArgs: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const searchValue = rawArgs.join(' ').trim();
    const result = await this.albumService.searchAlbum(
      searchValue || null,
      user,
      context.guildId,
    );

    if (!result) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        searchValue
          ? `Could not find any album matching \`${searchValue}\`.`
          : 'Could not find any currently playing or recent album for your account.',
      );
    }

    const requesterName = context.message?.author.displayName ?? user.userNameLastFm;
    const accentColor = context.accentColor;

    return AlbumBuilders.buildAlbumInfoResponse(result, user, requesterName, accentColor);
  }

  private async albumTracksAsync(context: ContextModel, rawArgs: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const searchValue = rawArgs.join(' ').trim();
    const result = await this.albumService.searchAlbum(
      searchValue || null,
      user,
      context.guildId,
    );

    if (!result) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        searchValue
          ? `Could not find any album matching \`${searchValue}\`.`
          : 'Could not find any currently playing or recent album for your account.',
      );
    }

    const requesterName = context.message?.author.displayName ?? user.userNameLastFm;
    const accentColor = context.accentColor;

    return AlbumBuilders.buildAlbumTracksResponse(result, user, requesterName, 1, accentColor);
  }
}
