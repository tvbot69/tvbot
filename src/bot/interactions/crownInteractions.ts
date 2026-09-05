import {
  ButtonInteraction,
  MessageFlags,
  StringSelectMenuInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';
import { injectable, inject, container } from 'tsyringe';
import { CrownService } from '@bot/services/crown/crownService';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { ContextModel } from '@bot/models/contextModel';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import type { CrownViewType } from '@domain/models/crownModels';

@injectable()
export class CrownInteractions {
  constructor(
    @inject(CrownService) private readonly crownService: CrownService,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;
    if (customId === 'user-crownpicker') {
      const selectedValue = interaction.values[0];
      if (!selectedValue) return;

      // format: callerDiscordId-targetDiscordId-viewType
      const parts = selectedValue.split('-');
      if (parts.length < 3) return;

      const callerDiscordId = parts[0]!;
      const targetDiscordId = parts[1]!;
      const viewType = parts[2]! as CrownViewType;

      const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!targetUser) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const member = interaction.guild?.members.cache.get(targetDiscordId);
      const displayName = member?.displayName ?? targetUser.userNameLastFm;

      const guildId = interaction.guildId!;
      const crowns = await this.crownService.getUserCrowns(guildId, targetUser.userId, viewType);
      const accentColor = await this.colorService.getAccentColorAsync(guildId);

      const response = CrownBuilders.buildCrownsResponse(
        displayName,
        callerDiscordId,
        targetDiscordId,
        crowns,
        1,
        viewType,
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
      return;
    }

    if (customId === 'guild-members') {
      const selectedValue = interaction.values[0];
      if (!selectedValue) return;

      const guildId = interaction.guildId!;
      const caller = await this.userService.getUserByDiscordId(interaction.user.id);
      const accentColor = await this.colorService.getAccentColorAsync(guildId);
      const guildName = interaction.guild?.name ?? 'Server';

      if (selectedValue === 'Crowns') {
        const { entries, totalActiveCrowns } = await this.crownService.getGuildLeaderboard(guildId);

        for (const item of entries) {
          const m = interaction.guild?.members.cache.get(item.discordUserId);
          if (m) item.displayName = m.displayName;
        }

        const response = CrownBuilders.buildCrownLeaderboardResponse(
          guildName,
          entries,
          caller?.userId,
          1,
          totalActiveCrowns,
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
      }
      return;
    }
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    // 1) Handle WhoKnows button click from crown duel embed
    if (customId.startsWith('artist-whoknows:')) {
      const raw = customId.slice('artist-whoknows:'.length);
      let artistName = decodeURIComponent(raw);
      if (/^\d+$/.test(raw)) {
        try {
          const artistRepo = container.resolve(ArtistRepository);
          const artist = await artistRepo.getArtistById(parseInt(raw, 10));
          if (artist) artistName = artist.name;
        } catch {
          // fallback to decodeURIComponent
        }
      }

      await interaction.deferUpdate().catch(() => undefined);

      const context = new ContextModel();
      (context as any).interaction = interaction;
      context.discordUserId = interaction.user.id;
      context.guildId = interaction.guildId ?? undefined;
      context.accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      const whoKnowsCommands = container.resolve(WhoKnowsCommands);
      const response = await whoKnowsCommands.whoKnowsArtistAsync(context, artistName);

      // Add a "Crown" button to allow switching back to the crown embed
      const crownBtn = new ButtonBuilder()
        .setCustomId(`artist-crown:${encodeURIComponent(artistName)}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Crown')
        .setEmoji({ name: '👑' } as any);
      response.addButtonRow(0, new ActionRowBuilder<ButtonBuilder>().addComponents(crownBtn));

      if (response.isComponentsV2 && response.componentsV2Container) {
        await (interaction as any).editReply({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
      } else {
        const hasEmbed = response.hasEmbed();
        await interaction.editReply({
          content: response.content ?? '',
          embeds: hasEmbed ? response.buildEmbed() : [],
          components: response.buildComponents(),
        }).catch(() => undefined);
      }
      return;
    }

    // 2) Handle Crown button click to toggle back to crown duel embed
    if (customId.startsWith('artist-crown:')) {
      const raw = customId.slice('artist-crown:'.length);
      let artistName = decodeURIComponent(raw);
      if (/^\d+$/.test(raw)) {
        try {
          const artistRepo = container.resolve(ArtistRepository);
          const artist = await artistRepo.getArtistById(parseInt(raw, 10));
          if (artist) artistName = artist.name;
        } catch {
          // fallback to decodeURIComponent
        }
      }

      await interaction.deferUpdate().catch(() => undefined);

      const context = new ContextModel();
      (context as any).interaction = interaction;
      context.discordUserId = interaction.user.id;
      context.guildId = interaction.guildId ?? undefined;
      context.accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      const crownCommands = container.resolve(CrownCommands);
      const response = await crownCommands.crownAsync(context, [artistName]);

      if (response.isComponentsV2 && response.componentsV2Container) {
        await (interaction as any).editReply({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
      } else {
        const hasEmbed = response.hasEmbed();
        await interaction.editReply({
          content: response.content ?? '',
          embeds: hasEmbed ? response.buildEmbed() : [],
          components: response.buildComponents(),
        }).catch(() => undefined);
      }
      return;
    }

    // 3) Handle crowns pagination
    if (!customId.startsWith('crowns-page:')) return;

    // crowns-page:action:callerDiscordId:targetDiscordId:viewType:page
    const parts = customId.split(':');
    if (parts.length < 6) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const viewType = parts[4]! as CrownViewType;
    const currentPage = parseInt(parts[5]!, 10) || 1;

    const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const guildId = interaction.guildId!;
    const crowns = await this.crownService.getUserCrowns(guildId, targetUser.userId, viewType);
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(crowns.length / pageSize));

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;
    else if (action === 'jump') newPage = Math.min(totalPages, Math.max(1, Math.floor(totalPages / 2)));

    const member = interaction.guild?.members.cache.get(targetDiscordId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(guildId);

    const response = CrownBuilders.buildCrownsResponse(
      displayName,
      callerDiscordId,
      targetDiscordId,
      crowns,
      newPage,
      viewType,
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
  }
}
