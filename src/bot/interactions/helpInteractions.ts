import { injectable } from 'tsyringe';
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import { HelpBuilders, type HelpCategory } from '@bot/builders/helpBuilders';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { Logger } from '@domain/logger';

@injectable()
export class HelpInteractions {
  constructor(
    private readonly prefixService: PrefixService,
    private readonly colorService: ColorService,
  ) {}

  public async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const selectedCategory = (interaction.values[0] as HelpCategory) || 'home';
    const parts = interaction.customId.split(':');
    const targetUserId = parts[2] === 'all' ? undefined : parts[2];

    const prefix = await this.prefixService.getPrefix(interaction.guildId);
    const accentColor =
      (await this.colorService.getAccentColorAsync(interaction.user.id)) ??
      (interaction.guildId ? await this.colorService.getAccentColorAsync(interaction.guildId) : undefined);

    const response = HelpBuilders.buildHelpResponse(
      selectedCategory,
      prefix,
      targetUserId ?? interaction.user.id,
      accentColor,
    );

    await interaction
      .update({
        embeds: response.buildEmbed(),
        components: response.buildComponents(),
      })
      .catch((err) => {
        Logger.warn({ err }, 'Failed to update help dropdown interaction');
      });
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    const category = (parts[2] as HelpCategory) || 'home';
    const targetUserId = parts[3] === 'all' ? undefined : parts[3];

    const prefix = await this.prefixService.getPrefix(interaction.guildId);
    const accentColor =
      (await this.colorService.getAccentColorAsync(interaction.user.id)) ??
      (interaction.guildId ? await this.colorService.getAccentColorAsync(interaction.guildId) : undefined);

    const response = HelpBuilders.buildHelpResponse(
      category,
      prefix,
      targetUserId ?? interaction.user.id,
      accentColor,
    );

    await interaction
      .update({
        embeds: response.buildEmbed(),
        components: response.buildComponents(),
      })
      .catch((err) => {
        Logger.warn({ err }, 'Failed to update help button interaction');
      });
  }
}
