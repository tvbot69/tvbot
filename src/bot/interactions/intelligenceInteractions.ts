import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { MusicIntelligenceService, type GapEntityType } from '@bot/services/musicIntelligenceService';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class IntelligenceInteractions {
  constructor(
    @inject(MusicIntelligenceService) private readonly intelligenceService: MusicIntelligenceService,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith('affinity-page:')) {
      await this.handleAffinityPage(interaction);
      return;
    }

    if (customId.startsWith('discoveries-page:')) {
      await this.handleDiscoveriesPage(interaction);
      return;
    }

    if (customId.startsWith('gaps-page:')) {
      await this.handleGapsPage(interaction);
      return;
    }
  }

  private async handleAffinityPage(interaction: ButtonInteraction): Promise<void> {
    // affinity-page:action:callerId:targetId:page:totalPages
    const parts = interaction.customId.split(':');
    if (parts.length < 6) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const currentPage = parseInt(parts[4]!, 10) || 1;
    const totalPages = parseInt(parts[5]!, 10) || 1;

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;

    const lookupId = targetDiscordId !== '0' ? targetDiscordId : callerDiscordId;
    const targetUser = await this.userService.getUserByDiscordId(lookupId);
    if (!targetUser || !interaction.guild) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const member = await interaction.guild.members.fetch(lookupId).catch(() => null);
    const displayName = member?.displayName || targetUser.userNameLastFm;

    const affinityData = await this.intelligenceService.getGuildAffinity(
      interaction.guild.id,
      targetUser.userId,
      displayName,
      targetUser.userNameLastFm,
      interaction.guild.name,
    );

    const accentColor = await this.colorService.getAccentColorAsync(lookupId);
    const response = IntelligenceBuilders.buildAffinityResponse({
      data: affinityData,
      page: newPage,
      pageSize: 12,
      callerDiscordId,
      targetDiscordId,
      accentColor,
    });

    if (response.componentsV2Container) {
      await (interaction as any).update({
        components: [response.componentsV2Container as any],
        flags: MessageFlags.IsComponentsV2,
      } as any).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }

  private async handleDiscoveriesPage(interaction: ButtonInteraction): Promise<void> {
    // discoveries-page:action:callerId:targetId:page:totalPages
    const parts = interaction.customId.split(':');
    if (parts.length < 6) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const currentPage = parseInt(parts[4]!, 10) || 1;
    const totalPages = parseInt(parts[5]!, 10) || 1;

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;

    const lookupId = targetDiscordId !== '0' ? targetDiscordId : callerDiscordId;
    const targetUser = await this.userService.getUserByDiscordId(lookupId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const end = new Date();
    const items = await this.intelligenceService.getDiscoveries(targetUser.userId, start, end);

    const member = interaction.guild?.members.cache.get(lookupId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(lookupId);

    const response = IntelligenceBuilders.buildDiscoveriesResponse({
      displayName,
      userNameLastFm: targetUser.userNameLastFm,
      periodDescription: 'the past 90 days',
      items,
      page: newPage,
      pageSize: 10,
      callerDiscordId,
      targetDiscordId,
      accentColor,
    });

    if (response.componentsV2Container) {
      await (interaction as any).update({
        components: [response.componentsV2Container as any],
        flags: MessageFlags.IsComponentsV2,
      } as any).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }

  private async handleGapsPage(interaction: ButtonInteraction): Promise<void> {
    // gaps-page:action:callerId:targetId:entityType:page:totalPages
    const parts = interaction.customId.split(':');
    if (parts.length < 7) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const entityType = parts[4]! as GapEntityType;
    const currentPage = parseInt(parts[5]!, 10) || 1;
    const totalPages = parseInt(parts[6]!, 10) || 1;

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;

    const lookupId = targetDiscordId !== '0' ? targetDiscordId : callerDiscordId;
    const targetUser = await this.userService.getUserByDiscordId(lookupId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const items = await this.intelligenceService.getListeningGaps(targetUser.userId, entityType, 90);

    const member = interaction.guild?.members.cache.get(lookupId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(lookupId);

    const response = IntelligenceBuilders.buildListeningGapsResponse({
      displayName,
      userNameLastFm: targetUser.userNameLastFm,
      entityType,
      items,
      page: newPage,
      pageSize: 10,
      callerDiscordId,
      targetDiscordId,
      accentColor,
    });

    if (response.componentsV2Container) {
      await (interaction as any).update({
        components: [response.componentsV2Container as any],
        flags: MessageFlags.IsComponentsV2,
      } as any).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }
}
