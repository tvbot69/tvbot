import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  MessageFlags,
} from 'discord.js';
import { inject, injectable } from 'tsyringe';
import { FootballService } from '@bot/services/football/footballService';
import { FootballBuilders, FOOTBALL_INTERACTION_PREFIX } from '@bot/builders/footballBuilders';
import { ColorService } from '@bot/services/colorService';
import { Logger } from '@domain/logger';

export const FOOTBALL_INTERACTION_PREFIXES = [
  `${FOOTBALL_INTERACTION_PREFIX}date:`,
  `${FOOTBALL_INTERACTION_PREFIX}refresh:`,
  `${FOOTBALL_INTERACTION_PREFIX}league:`,
];

@injectable()
export class FootballInteractions {
  constructor(
    @inject(FootballService) private readonly footballService: FootballService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith(FOOTBALL_INTERACTION_PREFIX)) return;

    try {
      const parts = customId.split(':');
      const action = parts[1]; // prev, today, next, date, refresh
      const leagueId = parts[2] || 'eng.1';
      const offset = parseInt(parts[3] || '0', 10);
      const isRefresh = action === 'refresh';

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch((err) => {
          Logger.debug(`[FootballInteractions] Button deferUpdate skipped/failed: ${err.message}`);
        });
      }

      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId ?? undefined);
      const schedule = await this.footballService.getScheduleAsync(leagueId, offset, isRefresh);
      const response = FootballBuilders.buildMatchesResponse(schedule, accentColor);

      if (interaction.deferred) {
        await interaction.editReply(response.toMessagePayload()).catch((err) => {
          Logger.debug(`[FootballInteractions] Failed to edit reply (interaction likely superseded): ${err.message}`);
        });
      } else if (!interaction.replied) {
        await interaction.update(response.toMessagePayload()).catch((err) => {
          Logger.debug(`[FootballInteractions] Failed to update reply: ${err.message}`);
        });
      }
    } catch (err: any) {
      Logger.error(`[FootballInteractions] Button handler error: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: '⚠️ Failed to update match dashboard.', flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      }
    }
  }

  public async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith(`${FOOTBALL_INTERACTION_PREFIX}league:`)) return;

    try {
      // Format: fb:league:{offset}
      const parts = customId.split(':');
      const offset = parseInt(parts[2] || '0', 10);
      const selectedLeagueId = interaction.values[0] || 'eng.1';

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch((err) => {
          Logger.debug(`[FootballInteractions] Select menu deferUpdate skipped/failed: ${err.message}`);
        });
      }

      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId ?? undefined);
      const schedule = await this.footballService.getScheduleAsync(selectedLeagueId, offset);
      const response = FootballBuilders.buildMatchesResponse(schedule, accentColor);

      if (interaction.deferred) {
        await interaction.editReply(response.toMessagePayload()).catch((err) => {
          Logger.debug(`[FootballInteractions] Failed to edit select menu reply (interaction likely superseded): ${err.message}`);
        });
      } else if (!interaction.replied) {
        await interaction.update(response.toMessagePayload()).catch((err) => {
          Logger.debug(`[FootballInteractions] Failed to update select menu reply: ${err.message}`);
        });
      }
    } catch (err: any) {
      Logger.error(`[FootballInteractions] Select menu handler error: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: '⚠️ Failed to switch league.', flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      }
    }
  }
}
