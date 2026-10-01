import { inject, injectable , container} from 'tsyringe';
import { ActionRowBuilder, ButtonInteraction, MessageFlags, ModalActionRowComponentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { TopBuilders } from '@bot/builders/topBuilders';
import { resolveTopBuildersDeps } from '@bot/builders/topBuildersDeps';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { SettingService } from '@bot/services/system/settingService';
import { ColorService } from '@bot/services/system/colorService';
import { registerModalHandler } from '@bot/interactions';
import { Logger } from '@domain/logger';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { respondToModalWithPage } from './modalPageResponse';

@injectable()
export class TopInteractions {

  constructor(
    @inject(LastFmRepository)
    private readonly lastfmRepository: LastFmRepository,
    @inject(SettingService)
    private readonly settingService: SettingService,
    @inject(ColorService)
    private readonly colorService: ColorService,
  ) {

    // Jump modals — "Enter a page number (1-31)" as in fmbot (Fergun AddJumpButton)
    registerModalHandler('top-jump', async (interaction) => {
      const raw = interaction.fields.getTextInputValue('page')?.trim();
      const pageNum = Number(raw);
      const [ , prefix, userNameLastFm, timeKey ] = interaction.customId.split(':');
      const totalPagesHint = 31;
      if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > totalPagesHint) {
        await interaction.reply({ content: `Invalid page number. Enter 1-${totalPagesHint}.`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        return;
      }
      const targetPage = Math.max(0, pageNum - 1);
      const timeSettings = this.settingService.getTimePeriod(decodeURIComponent(timeKey ?? 'weekly'));
      const displayName = decodeURIComponent(userNameLastFm ?? '');
      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
      // Ack before the Last.fm lookups below, not after. Discord gives a modal
      // submit 3 seconds; a slow upstream would otherwise surface as 10062.
      await interaction.deferReply().catch(() => undefined);
      try {
        let response: ResponseModel;
        if (prefix === 'topartists') {
          const items = await this.lastfmRepository.getTopArtists(displayName, timeSettings.timePeriod, 1000);
          response = await TopBuilders.buildTopArtistsResponse(resolveTopBuildersDeps(), displayName, displayName, items, timeSettings, Math.min(targetPage, Math.max(0, Math.ceil(items.length / 10) - 1)), accentColor);
        } else if (prefix === 'topalbums') {
          const items = await this.lastfmRepository.getTopAlbums(displayName, timeSettings.timePeriod, 1000);
          response = await TopBuilders.buildTopAlbumsResponse(resolveTopBuildersDeps(), displayName, displayName, items, timeSettings, Math.min(targetPage, Math.max(0, Math.ceil(items.length / 10) - 1)), accentColor);
        } else {
          const items = await this.lastfmRepository.getTopTracks(displayName, timeSettings.timePeriod, 1000);
          response = await TopBuilders.buildTopTracksResponse(resolveTopBuildersDeps(), displayName, displayName, items, timeSettings, Math.min(targetPage, Math.max(0, Math.ceil(items.length / 10) - 1)), accentColor);
        }
        await respondToModalWithPage(interaction, response);
      } catch (err) {
        // CORRECT AS IS: the modal is the boundary for all three `getTop*` reads
        // above - `tryHandleModal` only logs whatever escapes - and the escape
        // is a VISIBLE failure, not a rendered answer. The user submitted "go
        // to page 5" and gets "Failed to jump to page." back on the modal
        // reply, which is a true statement about what did not happen; it is not
        // an empty chart, a zero, or a "no data found" line they could mistake
        // for a genuine empty. `getTop*` raises before any builder runs, so no
        // plausible-wrong-number can escape through here. Re-throwing would buy
        // a vaguer message from a layer that has no idea what failed.
        Logger.error({ err }, 'Top jump modal failed');
        // Already deferred, so this edits the existing response rather than
        // replying a second time.
        await interaction.editReply({ content: 'Failed to jump to page.' }).catch(() => undefined);
      }
    });

    registerModalHandler('overview-jump', async (interaction) => {
      const raw = interaction.fields.getTextInputValue('page')?.trim();
      const pageNum = Number(raw);
      const [ , userNameLastFm, timeKey ] = interaction.customId.split(':');
      if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > 31) {
        await interaction.reply({ content: 'Invalid page number. Enter 1-31.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
        return;
      }
      const targetPage = Math.max(0, pageNum - 1);
      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
      // Same reasoning as the top-jump handler: ack first, look up second.
      await interaction.deferReply().catch(() => undefined);
      try {
        const { OverviewService } = await import('@bot/services/overviewService');
        const ovService = container.resolve(OverviewService);
        const overview = await ovService.getOverview(decodeURIComponent(userNameLastFm ?? ''));
        const timeSettings = this.settingService.getTimePeriod(decodeURIComponent(timeKey ?? 'weekly'));
        const { OverviewBuilders } = await import('@bot/builders/overviewBuilders');
        const response = OverviewBuilders.buildOverviewResponse(decodeURIComponent(userNameLastFm ?? ''), decodeURIComponent(userNameLastFm ?? ''), timeSettings.description, overview, Math.min(targetPage, Math.max(0, Math.ceil(overview.dailyBlocks.length / 4) - 1)), accentColor);
        await respondToModalWithPage(interaction, response);
      } catch (err) {
        // CORRECT AS IS: identical trade to the `top-jump` catch above, and
        // for the same reason. `OverviewService.getOverview` raises
        // `SourceUnavailableError` on a database outage, but this handler is
        // the boundary - `tryHandleModal` only logs an escape - and it answers
        // the user with "Failed to jump to page." So the raise does not become
        // an empty overview the user reads as a real one; it becomes a stated
        // failure. Nothing is rendered on the happy path of a failed read.
        Logger.error({ err }, 'Overview jump modal failed');
        await interaction.editReply({ content: 'Failed to jump to page.' }).catch(() => undefined);
      }
    });
  }

  public async handle(interaction: ButtonInteraction): Promise<void> {
    const id = interaction.customId;
    const parts = id.split(':');
    const prefix = parts[0];
    const action = parts[1];
    const currentPage = Number(parts[2] ?? 0);
    const userNameLastFm = parts[3] ? decodeURIComponent(parts[3]) : '';
    const timeKey = parts[4] ? decodeURIComponent(parts[4]) : 'weekly';

    // Jump → modal (matches picture: "Enter a page number" 1-31)
    if (action === 'jump') {
      const isOverview = prefix === 'overview';
      const modal = new ModalBuilder()
        .setCustomId(isOverview ? `overview-jump:${userNameLastFm}:${timeKey}` : `top-jump:${prefix}:${userNameLastFm}:${timeKey}`)
        .setTitle('Enter a page number');
      const input = new TextInputBuilder()
        .setCustomId('page')
        .setLabel('Page number (1-31)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('1')
        .setMinLength(1)
        .setMaxLength(2);
      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
      modal.addComponents(row as ActionRowBuilder<ModalActionRowComponentBuilder>);
      await interaction.showModal(modal).catch(async () => { await interaction.deferUpdate().catch(() => undefined); });
      return;
    }

    try {
      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      if (prefix === 'topartists' || prefix === 'topalbums' || prefix === 'toptracks') {
        const timeSettings = this.settingService.getTimePeriod(timeKey);
        const displayName = userNameLastFm;
        let response;
        if (prefix === 'topartists') {
          const items = await this.lastfmRepository.getTopArtists(userNameLastFm, timeSettings.timePeriod, 1000);
          const perPage = 10;
          const totalPages = Math.max(1, Math.ceil(items.length / perPage));
          let targetPage = currentPage;
          if (action === 'first') targetPage = 0;
          else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
          else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
          else if (action === 'last') targetPage = totalPages - 1;
          response = await TopBuilders.buildTopArtistsResponse(resolveTopBuildersDeps(), userNameLastFm, displayName, items, timeSettings, targetPage, accentColor);
        } else if (prefix === 'topalbums') {
          const items = await this.lastfmRepository.getTopAlbums(userNameLastFm, timeSettings.timePeriod, 1000);
          const perPage = 10;
          const totalPages = Math.max(1, Math.ceil(items.length / perPage));
          let targetPage = currentPage;
          if (action === 'first') targetPage = 0;
          else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
          else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
          else if (action === 'last') targetPage = totalPages - 1;
          response = await TopBuilders.buildTopAlbumsResponse(resolveTopBuildersDeps(), userNameLastFm, displayName, items, timeSettings, targetPage, accentColor);
        } else {
          const items = await this.lastfmRepository.getTopTracks(userNameLastFm, timeSettings.timePeriod, 1000);
          const perPage = 10;
          const totalPages = Math.max(1, Math.ceil(items.length / perPage));
          let targetPage = currentPage;
          if (action === 'first') targetPage = 0;
          else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
          else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
          else if (action === 'last') targetPage = totalPages - 1;
          response = await TopBuilders.buildTopTracksResponse(resolveTopBuildersDeps(), userNameLastFm, displayName, items, timeSettings, targetPage, accentColor);
        }
        await interaction.update({ embeds: response.buildEmbed(), components: response.buildComponents() }).catch(async () => { await interaction.deferUpdate().catch(() => undefined); });
        return;
      }
      if (prefix === 'overview') {
        const timeSettings = this.settingService.getTimePeriod(timeKey);
        const { OverviewService } = await import('@bot/services/overviewService');
        const { container: c } = await import('tsyringe');
        const ovService = c.resolve(OverviewService);
        const overview = await ovService.getOverview(userNameLastFm);
        const perPage = 4;
        const totalPages = Math.max(1, Math.ceil(overview.dailyBlocks.length / perPage));
        let targetPage = currentPage;
        if (action === 'first') targetPage = 0;
        else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
        else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
        else if (action === 'last') targetPage = totalPages - 1;
        const { OverviewBuilders } = await import('@bot/builders/overviewBuilders');
        const response = OverviewBuilders.buildOverviewResponse(userNameLastFm, userNameLastFm, timeSettings.description, overview, targetPage, accentColor);
        if (response.componentsV2Container) {
          await interaction.update({ components: [response.componentsV2Container], flags: MessageFlags.IsComponentsV2 }).catch(async () => { await interaction.deferUpdate().catch(() => undefined); });
        } else {
        await interaction.update({ embeds: response.buildEmbed(), components: response.buildComponents() }).catch(async () => { await interaction.deferUpdate().catch(() => undefined); });

        }
        return;
      }
      await interaction.deferUpdate().catch(() => undefined);
    } catch (err) {
      Logger.error({ err, prefix, action, userNameLastFm }, 'Top pagination interaction failed; message left unchanged');
      // The `getTop*` reads above and `getOverview` below RAISE
      // `LastFmUnavailableError`/`SourceUnavailableError` when the source could
      // not answer. Catching that here was laundering the deliberate signal back
      // into a dead button: the user pressed "next page", the card did not move,
      // and nothing - in Discord or in Railway - said the read had failed at
      // all. Narrowed so the deliberate failure propagates to
      // `interactionHandler.onInteractionCreated`, which is a real boundary and
      // answers the presser, while a genuine query failure still degrades to the
      // unchanged message. Same narrowing as
      // `countrySlashCommands.handleTopCountriesSlash`; the log above is kept so
      // the customId context survives the re-throw.
      if (isSourceUnavailable(err)) {
        throw err;
      }
      await interaction.deferUpdate().catch(() => undefined);
    }
  }
}
