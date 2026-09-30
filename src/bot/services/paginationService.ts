import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
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

    /**
     * The one message payload, for the first send and for every edit alike.
     *
     * Deliberately un-annotated. `reply`, `update` and `editReply` take three
     * different option interfaces whose `content` fields disagree
     * (`string | undefined` vs `string | null`), so naming any one of them here
     * would make the other two call sites a type error. The inferred shape
     * carries no `content` key at all, which is the only form all three accept.
     */
    const payloadFor = (page: number) => {
      const response = buildPage(page);
      const components = [
        ...response.buildComponents(),
        this.buildButtonRow(sessionId, page, totalPages),
      ];
      return { embeds: response.buildEmbed(), components };
    };

    /**
     * The FIRST page answers the slash interaction. There is nothing to edit
     * yet, so this is the one and only place `reply` is legal — and a slash
     * interaction can only ever be answered once, which is why every later page
     * goes through the button interaction instead.
     */
    const send = async (): Promise<void> => {
      const payload = payloadFor(state.page);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    };

    /**
     * Every later page EDITS THE ONE MESSAGE, through the interaction that
     * actually has a message to edit.
     *
     * This used to acknowledge the click with `i.update({})` — which strips the
     * button row off the original message — and then post the new page with
     * `interaction.reply`. Paging a 20-page chart therefore produced 20 messages
     * and 20 blanked originals, and it only worked by accident: the slash
     * interaction had already been answered by `send`, so the second `reply`
     * was a second answer to one interaction, which Discord rejects on some
     * paths and silently drops on others.
     *
     * `i.update(payload)` is the single call that both ACKS the click (it is an
     * interaction response, so the button stops spinning) and edits the message
     * in place, which is what every other paginator in a Discord client looks
     * like. An interaction that was already deferred or replied cannot be
     * `update`d — that is the documented error — so it gets `editReply`
     * instead. Both branches ack exactly once.
     */
    const show = async (i: ButtonInteraction): Promise<void> => {
      const payload = payloadFor(state.page);
      if (i.deferred || i.replied) {
        await i.editReply(payload);
      } else {
        await i.update(payload);
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
          await show(i);
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
          await show(i);
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
