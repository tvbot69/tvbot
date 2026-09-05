import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { UpdateService } from '@bot/services/updateService';
import { IndexService } from '@bot/services/indexService';
import { UpdateBuilders } from '@bot/builders/updateBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateType, parseUpdateType } from '@domain/enums/updateType';

const updateChoices = [
  { name: 'Recent Plays (Delta)', value: 'recent' },
  { name: 'Full (Artists, Albums, Tracks & Plays)', value: 'full' },
  { name: 'Top Artists', value: 'artists' },
  { name: 'Top Albums', value: 'albums' },
  { name: 'Top Tracks', value: 'tracks' },
  { name: 'All Plays (Historical Scrobbles)', value: 'plays' },
];

export class UpdateSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly updateService: UpdateService,
    private readonly indexService: IndexService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('update')
          .setDescription('Updates your cached Last.fm playcounts and library')
          .addStringOption(o =>
            o.setName('type')
              .setDescription('Type of update to perform')
              .addChoices(...updateChoices)
              .setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.updateAsync(ctx),
      },
    ];
  }

  private async updateAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    const rawOption = context.interaction?.options.getString('type') ?? 'recent';
    const { updateType, optionPicked } = parseUpdateType(rawOption === 'recent' ? '' : rawOption);

    if (!optionPicked || updateType === UpdateType.RecentPlays) {
      const syncResult = await this.updateService.updateUserAndGetRecentTracks(user);
      const latestScrobble = syncResult.recentTracks.find(t => !t.nowPlaying)?.timePlayed;

      return UpdateBuilders.buildDeltaResult(user.userNameLastFm, {
        newPlays: syncResult.updateResult.newPlays,
        removedPlays: syncResult.updateResult.removedPlays,
        lastUpdate: new Date(),
        latestScrobble,
      });
    }

    const stats = await this.indexService.modularUpdate(user, updateType);
    return UpdateBuilders.buildModularResult(user.userNameLastFm, stats);
  }
}
