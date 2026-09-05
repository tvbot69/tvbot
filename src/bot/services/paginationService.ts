import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { ComponentInteractionTracker, type ComponentInteraction } from './componentInteractionTracker';
import type { ResponseModel } from '@bot/models/responseModel';

const DEFAULT_TTL_MS = 300000;

interface PaginationState {
  page: number;
}

export class PaginationService {
  private readonly tracker: ComponentInteractionTracker;

  constructor(tracker: ComponentInteractionTracker) {
    this.tracker = tracker;
  }

  public async sendPaginatedAsync(
    interaction: ChatInputCommandInteraction,
    totalPages: number,
    buildPage: (page: number) => ResponseModel,
  ): Promise<void> {
    const sessionId = randomUUID();
    const state: PaginationState = { page: 0 };

    const send = async (): Promise<void> => {
      const response = buildPage(state.page);
      const components = [
        ...response.buildComponents(),
        this.buildButtonRow(sessionId, state.page, totalPages),
      ];
      const payload = { embeds: response.buildEmbed(), components: components };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    };

    this.tracker.register(
      `tvb-pg:${sessionId}:prev`,
      async (i: ComponentInteraction) => {
        if (!i.isButton()) {
          return;
        }
        if (state.page > 0) {
          state.page--;
          await i.update({});
          await send();
        } else {
          await i.deferUpdate();
        }
      },
      DEFAULT_TTL_MS,
    );

    this.tracker.register(
      `tvb-pg:${sessionId}:next`,
      async (i: ComponentInteraction) => {
        if (!i.isButton()) {
          return;
        }
        if (state.page < totalPages - 1) {
          state.page++;
          await i.update({});
          await send();
        } else {
          await i.deferUpdate();
        }
      },
      DEFAULT_TTL_MS,
    );

    await send();
  }

  private buildButtonRow(
    sessionId: string,
    currentPage: number,
    totalPages: number,
  ): ActionRowBuilder<MessageActionRowComponentBuilder> {
    const prev = new ButtonBuilder()
      .setCustomId(`tvb-pg:${sessionId}:prev`)
      .setLabel('<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0);

    const indicator = new ButtonBuilder()
      .setCustomId(`tvb-pg:${sessionId}:indicator`)
      .setLabel(`${currentPage + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true);

    const next = new ButtonBuilder()
      .setCustomId(`tvb-pg:${sessionId}:next`)
      .setLabel('>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1);

    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    row.addComponents(prev, indicator, next);
    return row;
  }
}
