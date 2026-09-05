import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { UserService } from '@bot/services/userService';
import { PlayHistoryService } from '@bot/services/playHistoryService';
import { ArtworkService } from '@bot/services/artworkService';
import { ColorService } from '@bot/services/colorService';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

@injectable()
export class PlaycountInteractions {
  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(PlayHistoryService) private readonly playHistoryService: PlayHistoryService,
    @inject(ArtworkService) private readonly artworkService: ArtworkService,
    @inject(ColorService) private readonly colorService: ColorService,
    @inject('ILastfmRepository') private readonly lastfmRepo: ILastfmRepository,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('milestone:reroll:')) return;

    const parts = customId.split(':');
    if (parts.length < 4) return;

    const targetUserId = parseInt(parts[2]!, 10);
    const callerUserId = parseInt(parts[3]!, 10);

    const caller = await this.userService.getUserById(callerUserId);
    if (caller && interaction.user.id !== caller.discordUserId) {
      await interaction.reply({
        content: 'Only the user who initiated this command can reroll.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = await this.userService.getUserById(targetUserId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    try {
      const userInfo = await this.lastfmRepo.getUserInfo(targetUser.userNameLastFm);
      if (!userInfo || userInfo.playCount < 1) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const randomMilestone = Math.floor(Math.random() * userInfo.playCount) + 1;
      const milestonePlay = await this.playHistoryService.getMilestoneScrobble(
        targetUser.userNameLastFm,
        targetUser.sessionKey ?? null,
        userInfo.playCount,
        randomMilestone,
      );

      if (!milestonePlay) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      let albumCoverUrl: string | null = null;
      if (milestonePlay.albumName) {
        albumCoverUrl = await this.artworkService.getAlbumCoverUrl(milestonePlay.albumName, milestonePlay.artistName);
      }
      if (!albumCoverUrl) {
        albumCoverUrl = await this.artworkService.getTrackCoverUrl(milestonePlay.name, milestonePlay.artistName);
      }

      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      const member = interaction.guild?.members.cache.get(targetUser.discordUserId);
      const targetDisplayName = member?.displayName ?? targetUser.userNameLastFm;

      const response = PlaycountBuilders.buildMilestoneResponse(
        targetDisplayName,
        targetUser.userNameLastFm,
        randomMilestone,
        milestonePlay.artistName,
        milestonePlay.albumName,
        milestonePlay.name,
        milestonePlay.timePlayed,
        albumCoverUrl,
        accentColor,
        true,
        targetUserId,
        callerUserId,
      );

      await interaction.update(response.toMessagePayload() as Parameters<typeof interaction.update>[0]);
    } catch {
      await interaction.deferUpdate().catch(() => undefined);
    }
  }
}
