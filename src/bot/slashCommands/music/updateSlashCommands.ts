import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { IndexService } from '@bot/services/lastfm/indexService';
import { UpdateBuilders } from '@bot/builders/meta/updateBuilders';
import { UpdateType, parseUpdateType } from '@domain/enums/updateType';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

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
          ) as SlashCommandBuilder,
        executeAsync: (ctx) => this.updateAsync(ctx),
      },
    ];
  }

  private async updateAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in user) return user;

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
