import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { UserService } from '@bot/services/userService';
import { ProfileService } from '@bot/services/profileService';
import { ColorService } from '@bot/services/colorService';
import { ProfileBuilders } from '@bot/builders/profileBuilders';
import type { User } from '@domain/interfaces/iuserRepository';

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
      } as User;
    }

    let displayName = lastFmName;
    if (interaction.guild && targetDiscordId !== '0') {
      try {
        const member = await interaction.guild.members.fetch(targetDiscordId);
        if (member) displayName = member.displayName;
      } catch {
        // CORRECT AS IS: a Discord READ of a member object, and its only use is
        // the label on the card. `displayName` is already seeded with the Last.fm
        // name above, so a missing permission or a member who left costs a
        // cosmetically less specific label and no fact. The profile's numbers
        // come from `profileService` and are unaffected by this catch.
        //
        // Note the asymmetry with the `profile:history:` branch below, which
        // deliberately does NOT catch: there, a failure would have to be
        // reported, and `getProfileHistory` now raises precisely so it can be.
      }
    }

    if (isHistory) {
      const historyStats = await this.profileService.getProfileHistory(
        displayName,
        targetUser!,
      );
      if (!historyStats) {
        // CORRECT AS IS, and the null here is now a much narrower claim than it
        // was. `getProfileHistory` returns null in exactly one case:
        // `lastfmRepo.getUserInfo` returned null, which `orUnavailable` restricts
        // to a real Last.fm "no such user" (error 6). A database outage now
        // RAISES `SourceUnavailableError` instead of returning an object with
        // empty history - so this branch can no longer be a dropped connection,
        // and the two have genuinely separated. Acknowledging without editing
        // leaves the user's current tab alone, which is right: there is no
        // profile to show and no failure to report.
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      historyStats.accentColor = await this.colorService.getColorFromImageUrl(historyStats.lastFmUser.imageUrl);

      const response = ProfileBuilders.buildProfileHistoryResponse(historyStats, callerDiscordId);
      // Capture the container into a local so the undefined case is handled by the
      // compiler. `isComponentsV2` already checks the same thing, but a getter
      // cannot narrow the property it is derived from, which is why 35 call
      // sites carried an `as any` on this field. The local is the guard.
      const historyContainer = response.componentsV2Container;
      if (historyContainer) {
        await interaction.update({
          components: [historyContainer],
          flags: MessageFlags.IsComponentsV2,
        });
      } else {
        await interaction.update({
          embeds: response.embed ? [response.embed] : [],
          components: response.buildComponents(),
        });
      }
    } else {
      const profileStats = await this.profileService.getProfileStats(
        displayName,
        targetUser!,
      );
      if (!profileStats) {
        // CORRECT AS IS, same reasoning as the history branch above: the null is
        // `getUserInfo` reporting a real Last.fm "no such user", not an outage.
        // The note is that `getProfileStats` KEEPS its degraded reads rather than
        // raising - it falls back to Last.fm's own variety counts and omits the
        // friends and top-10 clauses, each logged at WARN. That is deliberate and
        // documented at those sites: the fallback is a real number from a real
        // source, so a raise would cost the user a figure they could have seen.
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      profileStats.accentColor = await this.colorService.getColorFromImageUrl(profileStats.lastFmUser.imageUrl);

      const response = ProfileBuilders.buildProfileResponse(profileStats, callerDiscordId);
      const profileContainer = response.componentsV2Container;
      if (profileContainer) {
        await interaction.update({
          components: [profileContainer],
          flags: MessageFlags.IsComponentsV2,
        });
      } else {
        await interaction.update({
          embeds: response.embed ? [response.embed] : [],
          components: response.buildComponents(),
        });
      }
    }
  }
}
