import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { RecentBuilders } from '@bot/builders/recentBuilders';

@injectable()
export class RecentInteractions {
  constructor(
    @inject(LastFmRepository) private readonly lastfmRepo: ILastfmRepository,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('recent:')) return;

    // recent:prev:1:123456:username or recent:next:1:123456:username
    const parts = customId.split(':');
    if (parts.length < 5) return;

    const action = parts[1]; // 'prev' or 'next'
    const currentPage = parseInt(parts[2]!, 10) || 1;
    const targetDiscordId = parts[3]!;
    const userNameLastFm = decodeURIComponent(parts[4]!);

    const newPage = action === 'prev' ? Math.max(1, currentPage - 1) : Math.min(80, currentPage + 1);

    const member = interaction.guild?.members.cache.get(targetDiscordId);
    const displayName = member?.displayName ?? userNameLastFm;

    try {
      const user = await this.userService.getUserByDiscordId(targetDiscordId).catch(() => null);
      const sessionKey = user?.sessionKey;

      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      const recentData = await this.lastfmRepo.getUserRecentTracksWithMetadata(
        userNameLastFm,
        6,
        newPage,
        undefined,
        sessionKey,
      );
      if (!recentData || recentData.tracks.length === 0) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const response = RecentBuilders.buildRecentTracksResponse(
        userNameLastFm,
        displayName,
        targetDiscordId,
        recentData,
        newPage,
        accentColor,
      );

      if (response.componentsV2Container) {
        await (interaction as any).update({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(async () => {
          await interaction.deferUpdate().catch(() => undefined);
        });
      }
    } catch {
      await interaction.deferUpdate().catch(() => undefined);
    }
  }
}
