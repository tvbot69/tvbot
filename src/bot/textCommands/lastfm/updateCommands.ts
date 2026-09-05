import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { UpdateService } from '@bot/services/updateService';
import { IndexService } from '@bot/services/indexService';
import { UpdateBuilders } from '@bot/builders/updateBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateType, parseUpdateType } from '@domain/enums/updateType';

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
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

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
