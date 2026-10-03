import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { TasteService } from '@bot/services/library/tasteService';
import type { TasteData } from '@bot/services/library/tasteService';
import { TasteBuilders } from '@bot/builders/library/tasteBuilders';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { isSourceUnavailable } from '@domain/models/errors/sourceUnavailableError';
import { isLastFmUnavailable } from '@domain/models/errors/lastfmUnavailableError';
import { container } from 'tsyringe';
import { ArtworkService } from '@bot/services/media/artworkService';
import { ColorService } from '@bot/services/system/colorService';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

export class TasteSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly tasteService: TasteService,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('taste')
          .setDescription('Compares music taste between two users')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Discord user to compare with').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('username').setDescription('Last.fm username to compare with').setRequired(false),
          ) as SlashCommandBuilder,
        executeAsync: (ctx) => this.tasteAsync(ctx),
      },
    ];
  }

  private async tasteAsync(context: ContextModel): Promise<ResponseModel> {
    const caller = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in caller) return caller;

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    const targetUserOpt = context.interaction?.options.getUser('user');
    const targetUsernameOpt = context.interaction?.options.getString('username')?.trim();

    if (!targetUserOpt && !targetUsernameOpt) {
      return GenericEmbedService.buildWrongInputResponse('Please specify either a Discord user or a Last.fm username to compare with.');
    }

    let targetDiscordId: string | null = null;
    let targetLastFmUsername: string | null = null;
    let targetDisplayName: string = '';

    if (targetUserOpt) {
      targetDiscordId = targetUserOpt.id;
      const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!targetUser) {
        return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
      }
      targetLastFmUsername = targetUser.userNameLastFm;
      targetDisplayName = context.guild?.members.cache.get(targetDiscordId)?.displayName ?? targetUserOpt.username;

      if (UpdateService.needsUpdate(targetUser, 2)) {
        void this.updateService.updateUser(targetUser.userId, { accurateTotal: true });
      }
    } else if (targetUsernameOpt) {
      const possibleUser = await this.userService.getUserByLastFmName(targetUsernameOpt);
      if (possibleUser) {
        targetDiscordId = possibleUser.discordUserId;
        targetLastFmUsername = possibleUser.userNameLastFm;
        targetDisplayName = context.guild?.members.cache.get(possibleUser.discordUserId)?.displayName ?? possibleUser.userNameLastFm;
      } else {
        targetLastFmUsername = targetUsernameOpt;
        targetDisplayName = targetUsernameOpt;
      }
    }

    if (!targetLastFmUsername) {
      return GenericEmbedService.buildNotFoundResponse('Could not resolve user to compare with.');
    }

    const callerDisplayName = context.member?.displayName ?? caller.userNameLastFm;

    // Same contract as the text route: a source failure raises out of
    // `getTasteData` rather than arriving as an empty comparison, and the
    // interaction boundary would otherwise answer with a generic "something
    // went wrong" that names neither the cause nor the fact that it is retryable.
    let tasteData: TasteData;
    try {
      tasteData = await this.tasteService.getTasteData(
        {
          discordUserId: caller.discordUserId,
          displayName: callerDisplayName,
          userNameLastFm: caller.userNameLastFm,
        },
        {
          discordUserId: targetDiscordId ?? '0',
          displayName: targetDisplayName,
          userNameLastFm: targetLastFmUsername,
        },
        'two-year',
      );
    } catch (err) {
      // A defect must keep looking like a defect. Reporting it as an outage
      // would tell the user to retry a request that cannot ever succeed.
      if (!isSourceUnavailable(err)) throw err;
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Could not load taste for ${targetDisplayName} — ${isLastFmUnavailable(err) ? 'Last.fm' : 'the database'} is unreachable. Please try again later.`,
      );
    }

    const topArtist = tasteData.artists.items[0]?.name;
    const artService = container.resolve(ArtworkService);
    const colorService = container.resolve(ColorService);
    const imgUrl = topArtist ? await artService.getArtistImageUrl(topArtist) : null;
    const accentColor = await colorService.getColorFromImageUrl(imgUrl);

    return TasteBuilders.buildTasteResponse(tasteData, 0, 14, accentColor);
  }
}
