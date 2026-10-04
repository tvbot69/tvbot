import { inject, injectable } from 'tsyringe';
import {
  ActionRowBuilder,
  ButtonInteraction,
  ContainerBuilder,
  MessageFlags,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import { Logger } from '@domain/logging/logger';
import { registerModalHandler } from '@bot/interactions';
import { RymTransport, getArtist, getChart } from '@rateyourmusic/api/rymClient';
import { RymBuilders } from '@bot/builders/rateyourmusic/rymBuilders';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';

const CHART_PREFIX = 'rymchart';
const ARTIST_PREFIX = 'rymartist';

const ARTSIST_DISCO_PER_PAGE = 10;
const CHART_ENTRIES_PER_PAGE = 15;

/**
 * Page navigation for the two Rate Your Music cards that are lists rather than
 * single answers: the artist discography and the period chart.
 *
 * WHY A REBUILD, NOT A STORED PAGE
 * -------------------------------
 * The press re-reads the source and rebuilds the same card. Storing rendered
 * pages per message would hold FlareSolverr HTML in memory for every message
 * still in a channel, and the press would then be able to render a page whose
 * source has since failed — a stale list presented as current. `RymTransport`
 * answers a repeat read from its own short-lived cache, so the rebuild is cheap
 * and the card can never outlive its data.
 */
@injectable()
export class RymInteractions {
  constructor(
    @inject(RymTransport) private readonly rymTransport: RymTransport,
    @inject(ColorService) private readonly colorService: ColorService,
    @inject(ArtworkService) private readonly artworkService: ArtworkService,
  ) {
    registerModalHandler(`${CHART_PREFIX}-jump`, async (interaction) => {
      await this.handleJump(interaction, CHART_PREFIX);
    });
    registerModalHandler(`${ARTIST_PREFIX}-jump`, async (interaction) => {
      await this.handleJump(interaction, ARTIST_PREFIX);
    });
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    const prefix = parts[0];
    const action = parts[1];
    const currentPage = Number(parts[2] ?? 0);
    const slug = decodeURIComponent(parts[3] ?? '');

    if (prefix === CHART_PREFIX && action === 'jump') {
      await this.showJumpModal(interaction, CHART_PREFIX, slug);
      return;
    }
    if (prefix === ARTIST_PREFIX && action === 'jump') {
      await this.showJumpModal(interaction, ARTIST_PREFIX, slug);
      return;
    }

    try {
      if (prefix === CHART_PREFIX) {
        const stubs = await getChart(this.rymTransport, `/charts/top/album/${slug}/`);
        const totalPages = Math.max(1, Math.ceil(stubs.length / CHART_ENTRIES_PER_PAGE));
        const page = this.targetPage(action, currentPage, totalPages);
        const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
        const response = RymBuilders.buildChartResponse(slug, stubs, accentColor, page + 1);
        await this.update(interaction, response.componentsV2Container);
        return;
      }
      if (prefix === ARTIST_PREFIX) {
        const artist = await getArtist(this.rymTransport, slug);
        const totalPages = Math.max(1, Math.ceil(artist.discography.length / ARTSIST_DISCO_PER_PAGE));
        const page = this.targetPage(action, currentPage, totalPages);
        const coverUrl = await this.artworkService.getArtistImageUrl(artist.name);
        const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
        const response = RymBuilders.buildArtistResponse(artist, accentColor, coverUrl, page + 1);
        await this.update(interaction, response.componentsV2Container);
        return;
      }
      await this.quietly(() => interaction.deferUpdate(), 'deferUpdate on an unrouted press');
    } catch (err) {
      Logger.error({ err, prefix, action, slug }, 'RYM pagination failed; card left unchanged');
      await this.quietly(() => interaction.deferUpdate(), 'deferUpdate after a failed read');
    }
  }

  /** Discord transport for a control press. A navigation button that cannot
   *  reach Discord must leave the card the user is already looking at alone
   *  rather than replace it, so the failure is acknowledged without editing and
   *  the reason is recorded. It is a transport outcome, not a data answer. */
  private async quietly(work: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await work();
    } catch (err) {
      Logger.debug({ err: String(err).slice(0, 80) }, `RYM ${what} failed`);
    }
  }

  private async handleJump(interaction: ModalSubmitInteraction, prefix: string): Promise<void> {
    const slug = decodeURIComponent(interaction.customId.slice(`${prefix}-jump:`.length));
    const raw = interaction.fields.getTextInputValue('page')?.trim();
    const pageNumber = Number(raw);
    await this.quietly(() => interaction.deferReply(), 'modal deferReply');
    try {
      if (prefix === CHART_PREFIX) {
        const stubs = await getChart(this.rymTransport, `/charts/top/album/${slug}/`);
        const totalPages = Math.max(1, Math.ceil(stubs.length / CHART_ENTRIES_PER_PAGE));
        const page = Math.min(Math.max(1, pageNumber), totalPages) - 1;
        const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
        const response = RymBuilders.buildChartResponse(slug, stubs, accentColor, page + 1);
        await this.replyWith(interaction, response.componentsV2Container);
        return;
      }
      const artist = await getArtist(this.rymTransport, slug);
      const totalPages = Math.max(1, Math.ceil(artist.discography.length / ARTSIST_DISCO_PER_PAGE));
      const page = Math.min(Math.max(1, pageNumber), totalPages) - 1;
      const coverUrl = await this.artworkService.getArtistImageUrl(artist.name);
      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
      const response = RymBuilders.buildArtistResponse(artist, accentColor, coverUrl, page + 1);
      await this.replyWith(interaction, response.componentsV2Container);
    } catch (err) {
      Logger.error({ err, prefix, slug }, 'RYM jump modal failed');
      await this.quietly(
        () => interaction.editReply({ content: 'Failed to jump to page.' }),
        'jump failure notice',
      );
    }
  }

  private targetPage(action: string | undefined, currentPage: number, totalPages: number): number {
    if (action === 'first') return 0;
    if (action === 'prev') return Math.max(0, currentPage - 1);
    if (action === 'next') return Math.min(totalPages - 1, currentPage + 1);
    if (action === 'last') return totalPages - 1;
    return currentPage;
  }

  private async showJumpModal(interaction: ButtonInteraction, prefix: string, slug: string): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId(`${prefix}-jump:${slug}`)
      .setTitle('Enter a page number')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>()
          .addComponents(
            new TextInputBuilder()
              .setCustomId('page')
              .setLabel('Page number')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(2),
          ) as ActionRowBuilder<ModalActionRowComponentBuilder>,
      );
    try {
      await interaction.showModal(modal);
    } catch {
      // The message is older than the token allows editing; acknowledging the
      // press without touching the card is the correct fallback.
      await this.quietly(() => interaction.deferUpdate(), 'showModal fallback');
    }
  }

  private async update(interaction: ButtonInteraction, container: ContainerBuilder | undefined): Promise<void> {
    if (!container) {
      await this.quietly(() => interaction.deferUpdate(), 'deferUpdate with no container');
      return;
    }
    try {
      await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch {
      await this.quietly(() => interaction.deferUpdate(), 'update fallback');
    }
  }

  private async replyWith(interaction: ModalSubmitInteraction, container: ContainerBuilder | undefined): Promise<void> {
    if (!container) {
      await this.quietly(
        () => interaction.editReply({ content: 'Nothing to show.' }),
        'empty modal reply',
      );
      return;
    }
    try {
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
      Logger.debug({ err: String(err).slice(0, 80) }, 'RYM modal editReply failed');
    }
  }
}