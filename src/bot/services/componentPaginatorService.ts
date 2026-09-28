import {
  ActionRowBuilder,
  ButtonInteraction,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  type APIMessageTopLevelComponent,
} from 'discord.js';
import { singleton } from 'tsyringe';
import { Logger } from '@domain/logger';
import { registerModalHandler } from '@bot/interactions';

export interface ComponentPaginatorSession {
  currentPage: number;
  totalPages: number;
  renderPage: (pageIndex: number) => Promise<ContainerBuilder> | ContainerBuilder;
  authorDiscordId?: string;
  expiresAt: number;
}

export const PAGINATOR_MODAL_PREFIX = 'comp_page_jump';

@singleton()
export class ComponentPaginatorService {
  private readonly sessions = new Map<string, ComponentPaginatorSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.ensureCleanupTimer();

    // Register modal submission handler for jumping to a specific page
    registerModalHandler(PAGINATOR_MODAL_PREFIX, async (interaction: ModalSubmitInteraction) => {
      await this.handleJumpModal(interaction);
    });
  }

  public registerSession(messageId: string, session: ComponentPaginatorSession): void {
    this.sessions.set(messageId, session);
    this.ensureCleanupTimer();
  }

  public getSession(messageId: string): ComponentPaginatorSession | undefined {
    const session = this.sessions.get(messageId);
    if (!session) return undefined;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(messageId);
      return undefined;
    }
    return session;
  }

  public async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;
    if (!customId.startsWith('component_paginator_')) {
      return false;
    }

    const messageId = interaction.message.id;
    const session = this.getSession(messageId);
    if (!session) {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'This paginator has expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
      return true;
    }

    // Refresh TTL on active interaction (15 minutes)
    session.expiresAt = Date.now() + 15 * 60 * 1000;

    if (customId === 'component_paginator_jump') {
      const modal = new ModalBuilder()
        .setCustomId(`${PAGINATOR_MODAL_PREFIX}:${messageId}`)
        .setTitle('Jump to Page');

      const input = new TextInputBuilder()
        .setCustomId('page_number')
        .setLabel(`Page number (1-${session.totalPages})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('1')
        .setMinLength(1)
        .setMaxLength(String(session.totalPages).length);

      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
      modal.addComponents(row);

      await interaction.showModal(modal).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
      return true;
    }

    let targetPage = session.currentPage;
    if (customId === 'component_paginator_first') {
      targetPage = 0;
    } else if (customId === 'component_paginator_previous') {
      targetPage = Math.max(0, session.currentPage - 1);
    } else if (customId === 'component_paginator_next') {
      targetPage = Math.min(session.totalPages - 1, session.currentPage + 1);
    } else if (customId === 'component_paginator_last') {
      targetPage = session.totalPages - 1;
    }

    if (targetPage === session.currentPage) {
      await interaction.deferUpdate().catch(() => undefined);
      return true;
    }

    session.currentPage = targetPage;
    try {
      const updatedContainer = await session.renderPage(targetPage);
      await interaction.update({
        components: [updatedContainer],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      Logger.error({ err, messageId, targetPage }, 'Failed to render paginator page');
      await interaction.deferUpdate().catch(() => undefined);
    }

    return true;
  }

  public async handleJumpModal(interaction: ModalSubmitInteraction): Promise<void> {
    const raw = interaction.fields.getTextInputValue('page_number')?.trim();
    const pageNum = Number(raw);
    const [, messageId] = interaction.customId.split(':');

    if (!messageId) {
      await interaction.reply({ content: 'Invalid paginator session.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    const session = this.getSession(messageId);
    if (!session) {
      await interaction.reply({ content: 'This paginator has expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > session.totalPages) {
      await interaction.reply({ content: `Invalid page number. Enter 1-${session.totalPages}.`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    const targetPage = Math.max(0, Math.min(session.totalPages - 1, pageNum - 1));

    // Ack before rendering the page. Discord allows a modal submit 3 seconds to
    // be answered, and renderPage is not free - it rebuilds the whole card.
    // Deferring first makes this handler's latency irrelevant.
    await interaction.deferReply().catch(() => undefined);

    try {
      const updatedContainer = await session.renderPage(targetPage);
      session.currentPage = targetPage;
      session.expiresAt = Date.now() + 15 * 60 * 1000;
      // Documented API only.
      //
      // This used to be `if (interaction.isFromMessage()) { interaction.update(...) }
      // else { (interaction as any).update(...) }` - two branches whose bodies
      // were byte-identical apart from a cast, so the branch decided nothing.
      //
      // It compiled in the first arm because `isFromMessage()` is a TYPE GUARD,
      // which narrowed a ModalSubmitInteraction to a type that has update().
      // That is false confidence: `update()` is not declared on a modal in the
      // v14 typings at all. It exists on the runtime prototype (a v13
      // carry-over discord.js never typed), so this worked - but it worked by
      // accident, reachable only through a cast, and a minor release could have
      // removed it with no compile error anywhere.
      await interaction.editReply({
        components: [updatedContainer as unknown as APIMessageTopLevelComponent],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      Logger.error({ err, messageId, targetPage }, 'Failed to update jump page');
      // Already deferred, so edit the existing response rather than replying twice.
      await interaction.editReply({ content: 'Failed to update page.' }).catch(() => undefined);
    }
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (session.expiresAt < now) {
          this.sessions.delete(id);
        }
      }
      if (this.sessions.size === 0 && this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, 60000);
  }
}
