import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { UserService } from '@bot/services/userService';
import { ProfileService } from '@bot/services/profileService';
import { ColorService } from '@bot/services/colorService';
import { ProfileBuilders } from '@bot/builders/profileBuilders';

@injectable()
export class ProfileInteractions {
  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(ProfileService) private readonly profileService: ProfileService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('profile:history:') && !customId.startsWith('profile:view:')) {
      return;
    }

    const isHistory = customId.startsWith('profile:history:');
    const parts = customId.split(':');
    if (parts.length < 5) return;

    const targetDiscordId = parts[2]!;
    const callerDiscordId = parts[3]!;
    const lastFmName = parts[4]!;

    if (callerDiscordId !== '0' && interaction.user.id !== callerDiscordId) {
      await interaction.reply({
        content: 'Only the user who requested this profile can toggle tabs.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let targetUser = targetDiscordId !== '0'
      ? await this.userService.getUserByDiscordId(targetDiscordId)
      : await this.userService.getUserByLastFmName(lastFmName);

    if (!targetUser) {
      targetUser = {
        userId: 0,
        userNameLastFm: lastFmName,
        discordUserId: targetDiscordId !== '0' ? targetDiscordId : undefined,
      } as any;
    }

    const accentColor = targetDiscordId !== '0'
      ? await this.colorService.getAccentColorAsync(targetDiscordId)
      : undefined;

    let displayName = lastFmName;
    if (interaction.guild && targetDiscordId !== '0') {
      try {
        const member = await interaction.guild.members.fetch(targetDiscordId);
        if (member) displayName = member.displayName;
      } catch {
        // Fallback to username/lastFmName
      }
    }

    if (isHistory) {
      const historyStats = await this.profileService.getProfileHistory(
        displayName,
        targetUser!,
        accentColor,
      );
      if (!historyStats) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const response = ProfileBuilders.buildProfileHistoryResponse(historyStats, callerDiscordId);
      await interaction.update({
        embeds: response.embed ? [response.embed] : [],
        components: response.buildComponents(),
      });
    } else {
      const profileStats = await this.profileService.getProfileStats(
        displayName,
        targetUser!,
        accentColor,
      );
      if (!profileStats) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const response = ProfileBuilders.buildProfileResponse(profileStats, callerDiscordId);
      await interaction.update({
        embeds: response.embed ? [response.embed] : [],
        components: response.buildComponents(),
      });
    }
  }
}
