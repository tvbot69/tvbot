import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { IndexService } from '@bot/services/lastfm/indexService';
import { UpdateBuilders } from '@bot/builders/meta/updateBuilders';
import { UpdateType, parseUpdateType } from '@domain/enums/updateType';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

export class UpdateCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly updateService: UpdateService,
    private readonly indexService: IndexService,
  ) {
    this.commands = [
      {
        name: 'update',
        aliases: ['u'],
        executeAsync: (ctx, args) => this.updateAsync(ctx, args.join(' ')),
      },
    ];
  }

  private async updateAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;

    const { updateType, optionPicked } = parseUpdateType(rawOptions);

    // Delta update path: .update / .u (no options or unpicked)
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

    // Modular / Full update path: .update full, .update artists, .update albums, .update tracks, .update plays
    const stats = await this.indexService.modularUpdate(user, updateType);
    return UpdateBuilders.buildModularResult(user.userNameLastFm, stats);
  }
}
