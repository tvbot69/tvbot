import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { AlbumBuilders } from '@bot/builders/albumBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { AlbumService } from '@bot/services/albumService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

import { ColorService } from '@bot/services/colorService';

export class AlbumSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  private readonly userService: UserService;
  private readonly albumService: AlbumService;
  private readonly updateService: UpdateService;
  private readonly colorService?: ColorService;

  constructor(
    userService: UserService,
    albumService: AlbumService,
    updateService: UpdateService,
    colorService?: ColorService,
  ) {
    this.userService = userService;
    this.albumService = albumService;
    this.updateService = updateService;
    this.colorService = colorService;

    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('cover')
          .setDescription("Cover for current album or the one you're searching for.")
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Artist and/or album name').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Get the cover from another user').setRequired(false),
          ),
        executeAsync: (context) => {
          const name = context.interaction?.options.getString('name');
          const targetDiscordUser = context.interaction?.options.getUser('user');
          return this.coverSlashAsync(context, name, targetDiscordUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('album')
          .setDescription('Information about an album')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Artist and/or album name').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Get the album from another user').setRequired(false),
          ),
        executeAsync: (context) => {
          const name = context.interaction?.options.getString('name');
          const targetDiscordUser = context.interaction?.options.getUser('user');
          return this.albumSlashAsync(context, name, targetDiscordUser?.id);
        },
      },
    ];
  }

  private async coverSlashAsync(
    context: ContextModel,
    searchValue?: string | null,
    targetDiscordId?: string | null,
  ): Promise<ResponseModel> {
    const lookupId = targetDiscordId || context.discordUserId;
    const user = await this.userService.getUserByDiscordId(lookupId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        targetDiscordId
          ? 'That user has not connected their Last.fm account yet.'
          : 'You have not connected your Last.fm account yet. Use `/login` first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

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
          : 'Could not find any currently playing or recent album for that account.',
      );
    }

    const requesterName = context.interaction?.user.displayName ?? user.userNameLastFm;
    const accentColor = (targetDiscordId && targetDiscordId !== context.discordUserId)
      ? await this.colorService?.getAccentColorAsync(targetDiscordId)
      : context.accentColor;

    return AlbumBuilders.buildCoverResponse(result, user, requesterName, accentColor);
  }

  private async albumSlashAsync(
    context: ContextModel,
    searchValue?: string | null,
    targetDiscordId?: string | null,
  ): Promise<ResponseModel> {
    const lookupId = targetDiscordId || context.discordUserId;
    const user = await this.userService.getUserByDiscordId(lookupId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        targetDiscordId
          ? 'That user has not connected their Last.fm account yet.'
          : 'You have not connected your Last.fm account yet. Use `/login` first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

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
          : 'Could not find any currently playing or recent album for that account.',
      );
    }

    const requesterName = context.interaction?.user.displayName ?? user.userNameLastFm;
    const accentColor = (targetDiscordId && targetDiscordId !== context.discordUserId)
      ? await this.colorService?.getAccentColorAsync(targetDiscordId)
      : context.accentColor;

    return AlbumBuilders.buildAlbumInfoResponse(result, user, requesterName, accentColor);
  }
}
