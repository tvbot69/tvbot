import {
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  CheckboxGroupBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { inject, injectable } from 'tsyringe';
import { ChartService } from '@bot/services/chartService';
import { NotEnoughAlbumsError, TooManyImagesError } from '@bot/services/chartService';
import { ChartBuilders } from '@bot/builders/chartBuilders';
import { ChartSettings, TitleSetting } from '@bot/models/chartModels';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { registerModalHandler } from './index';
import { Logger } from '@domain/logger';

const MODAL_PREFIX = 'chart-edit-modal:';

const PERIOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'halfyearly', label: 'Half yearly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'overall', label: 'All time' },
];

const periodTokenToValue = (token: string): string => {
  const found = PERIOD_OPTIONS.find((o) => o.value === token.toLowerCase());
  return found?.value ?? 'weekly';
};

export const FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Tahoma', label: 'Tahoma' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Impact', label: 'Impact' },
];

@injectable()
export class ChartInteractions {
  private readonly chartService: ChartService;
  private readonly userService: UserService;
  private readonly colorService: ColorService;

  constructor(
    @inject(ChartService) chartService: ChartService,
    @inject(UserService) userService: UserService,
    @inject(ColorService) colorService: ColorService,
  ) {
    this.chartService = chartService;
    this.userService = userService;
    this.colorService = colorService;

    registerModalHandler(MODAL_PREFIX, async (interaction) => {
      await this.handleEditModal(interaction);
    });
  }

  public async handleEditButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    if (parts.length < 4) {
      return;
    }
    const [, creatorId, chartType, size, periodToken, titlesFlag, skipFlag, , rainbowFlag, singlesFlag] = parts;
    if (!creatorId || !chartType || !size || !periodToken) {
      return;
    }
    const targetLfm = parts[parts.length - 1] ?? '';

    if (interaction.user.id !== creatorId) {
      await interaction.reply({
        content: 'Only the chart creator can edit this chart.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isAlbum = chartType === 'a';
    const periodValue = periodTokenToValue(periodToken);

    const checkboxGroup = new CheckboxGroupBuilder()
      .setOptions(
        { label: 'Show titles', value: 'titles', default: titlesFlag === '1' },
        { label: 'Skip albums without image', value: 'skip', default: skipFlag === '1' },
        { label: 'SFW only', value: 'sfw', default: false },
        { label: 'Rainbow sort', value: 'rainbow', default: rainbowFlag === '1' },
        {
          label: isAlbum ? 'Hide singles' : 'Hide singles',
          value: 'hidesingles',
          default: singlesFlag === '1',
        },
      )
      .setCustomId('options')
      .setRequired(false);

    const modal = new ModalBuilder().setCustomId(
      `${MODAL_PREFIX}${creatorId}:${chartType}:${targetLfm}`,
    ).setTitle('Edit chart settings');

    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Size (e.g. 3x3)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('size')
            .setStyle(TextInputStyle.Short)
            .setValue(size)
            .setPlaceholder('3x3')
            .setMinLength(3)
            .setMaxLength(5)
            .setRequired(true),
        ),
    );

    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Time period')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('time_period')
            .addOptions(
              PERIOD_OPTIONS.map((o) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(o.label)
                  .setValue(o.value)
                  .setDefault(o.value === periodValue),
              ),
            )
            .setRequired(true),
        ),
    );

    modal.addLabelComponents(
      new LabelBuilder().setLabel('Options').setCheckboxGroupComponent(checkboxGroup),
    );

    if (isAlbum) {
      modal.addLabelComponents(
        new LabelBuilder()
          .setLabel('Release filter (e.g. 2024 or 1990s)')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('release_filter')
            .setStyle(TextInputStyle.Short)
              .setPlaceholder('2024 or 1990s')
              .setMaxLength(5)
              .setRequired(false),
          ),
      );
    }

    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Font')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('font')
            .addOptions(
              FONT_OPTIONS.map((o) =>
                new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value),
              ),
            )
            .setRequired(false),
        ),
    );

    await interaction.showModal(modal);
  }

  public async handleEditModal(interaction: ModalSubmitInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    const creatorId = parts[1];
    const chartType = parts[2];

    if (interaction.user.id !== creatorId) {
      await interaction.reply({
        content: 'Only the chart creator can edit this chart.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    try {
      const user = await this.userService.getUserByDiscordId(creatorId);
      if (!user) {
        await interaction.editReply({ content: 'Your account is no longer registered.', components: [] });
        return;
      }

      const sizeStr = interaction.fields.getTextInputValue('size') || '3x3';
      const periodValue = interaction.fields.getStringSelectValues('time_period')[0] ?? 'weekly';
      const checkedOptions = interaction.fields.getCheckboxGroup('options');

      const hasTitles = checkedOptions.includes('titles');
      const hasSkip = checkedOptions.includes('skip');
      const hasRainbow = checkedOptions.includes('rainbow');
      const hasSingles = checkedOptions.includes('hidesingles');

      const artistChart = chartType === 'r';
      const periodInput = periodValue || (artistChart ? 'weekly' : 'weekly');

      const { SettingService } = await import('@bot/services/settingService');
      const settingService = new SettingService();
      const timeSettings = settingService.getTimePeriod(periodInput);

      const chartSettings = new ChartSettings();
      const dimensions = ChartService.getDimensions(chartSettings, sizeStr);
      chartSettings.artistChart = artistChart;
      chartSettings.titleSetting = hasTitles ? TitleSetting.Titles : TitleSetting.TitlesDisabled;
      chartSettings.skipWithoutImage = hasSkip || hasRainbow;
      chartSettings.rainbowSortingEnabled = hasRainbow;
      chartSettings.filterSingles = hasSingles;
      chartSettings.timeSettings = timeSettings;
      chartSettings.timespanString = timeSettings.description;
      chartSettings.width = dimensions.chartSettings.width;
      chartSettings.height = dimensions.chartSettings.height;

      if (artistChart === false) {
        const releaseFilterStr = interaction.fields.getTextInputValue('release_filter')?.trim();
        if (releaseFilterStr) {
          if (
            releaseFilterStr.endsWith('s') &&
            /^\d{4}s$/i.test(releaseFilterStr)
          ) {
            const decade = Number(releaseFilterStr.slice(0, 4));
            if (decade >= 1900 && decade % 10 === 0) {
              chartSettings.releaseDecadeFilter = decade;
            }
          } else if (/^\d{4}$/.test(releaseFilterStr)) {
            const year = Number(releaseFilterStr);
            if (year >= 1900 && year <= 2100) {
              chartSettings.releaseYearFilter = year;
            }
          }
        }
      }

      const font = interaction.fields.getStringSelectValues('font')[0];
      if (font && font !== 'default') {
        chartSettings.customOptionsEnabled = true;
      }

      const accentColor = await this.colorService.getAccentColorAsync(
        interaction.guildId,
      );

      const chartResult = artistChart
        ? await this.chartService.generateArtistChart(
            creatorId,
            user.userNameLastFm,
            chartSettings,
            font,
          )
        : await this.chartService.generateAlbumChart(
            creatorId,
            user.userNameLastFm,
            chartSettings,
            font,
          );

      this.userService.enqueueUserUpdate(user, 'Command' as never);

      const displayName =
        interaction.member && 'displayName' in (interaction.member as object)
          ? (interaction.member as unknown as { displayName: string }).displayName
          : interaction.user.username;

      const response = artistChart
        ? ChartBuilders.buildArtistChartResponse(
            user,
            displayName,
            chartResult,
            chartSettings,
            accentColor,
          )
        : ChartBuilders.buildAlbumChartResponse(
            user,
            displayName,
            chartResult,
            chartSettings,
            accentColor,
          );

      const payload: Record<string, unknown> = response.isComponentsV2
        ? {
            components: [response.componentsV2Container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] as string[] },
          }
        : {
            embeds: response.buildEmbed(),
            components: response.buildComponents(),
            allowedMentions: { parse: [] as string[] },
          };
      if (response.hasFile()) {
        payload.files = [
          {
            attachment: response.fileBuffer,
            name: response.fileName,
            description: response.fileDescription,
          },
        ];
      }

      await interaction.editReply(payload);
    } catch (err) {
      if (err instanceof NotEnoughAlbumsError) {
        await interaction.editReply({
          components: [],
          content: ChartBuilders.buildNotEnoughAlbumsError(err).embed.data.description ?? 'Not enough albums.',
        });
        return;
      }
      if (err instanceof TooManyImagesError) {
        await interaction.editReply({
          components: [],
          content: 'Charts are limited to 100 total images (`10x10`).',
        });
        return;
      }
      Logger.error({ err }, 'Chart edit modal failed');
      await interaction.editReply({
        content: 'Something went wrong while regenerating the chart.',
        components: [],
      });
    }
  }
}

