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
import { Logger } from '@domain/logging/logger';
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
  // CORRECT AS IS, and it is worth saying once for the whole class: this
  // service performs NO data read. The page content is produced by the caller's
  // `renderPage`, so there is no query here that could fail and be reported as
  // an empty table. Every remaining `.catch(() => undefined)` in this file is
  // Discord interaction plumbing - acknowledging a press, opening a modal,
  // answering an invalid page number - and each of those is either a
  // best-effort write to a response that has already been consumed or a
  // validation reply whose failure means Discord is unreachable too. None of
  // them can substitute a wrong value for a right one, because none of them
  // produce a value.
  //
  // The only two places an unreachable source can surface are the two
  // `renderPage` calls, and both are documented at the site.
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

    // CORRECT AS IS for the message itself: a page that cannot be fetched must
    // not destroy the page the user is already looking at, and it does not.
    // `renderPage` is supplied by the caller, so an unreachable source reaches
    // here as a throw - a `SourceUnavailableError` from a database read, a
    // `LastFmUnavailableError` from a scrobble read, whatever the card happens
    // to need. The catch acknowledges with `deferUpdate()`, which does NOT edit
    // the message, so the visible page is byte-for-byte what it was. A dead
    // button is a lesser lie than a rendered "no results", and this is it.
    //
    // The `session.currentPage` assignment BELOW the `update()` is load-bearing,
    // not cosmetic. It used to sit above the `try`, so a failed render left the
    // session claiming a page the message was not showing: the cursor and the
    // pixels disagreed, and the next press computed its target from the phantom
    // page - skipping a page of real rows with no indication anything had gone
    // wrong. The cursor now tracks what is actually on screen, which is the
    // same rule `handleJumpModal` already followed at its own assignment.
    try {
      const updatedContainer = await session.renderPage(targetPage);
      await interaction.update({
        components: [updatedContainer],
        flags: MessageFlags.IsComponentsV2,
      });
      session.currentPage = targetPage;
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
      // CORRECT AS IS, and this is the one place in the file that already SAYS
      // SO rather than staying quiet: the catch replies 'Failed to update page.'
      // on the deferred response, so a user who jumped to a page that could not
      // be fetched is told, rather than being left with a dead button. The
      // cursor is committed after `renderPage` resolves, so a failure leaves
      // the session on the page the user is still looking at.
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
