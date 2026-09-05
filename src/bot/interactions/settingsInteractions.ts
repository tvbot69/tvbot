import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  type ButtonInteraction,
  MessageFlags,
} from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { registerModalHandler } from './index';
import { FmEmbedTypeNames } from '@domain/enums/fmEmbedType';

export const SETTINGS_BUTTON_PREFIX = 'settings-btn:';
const PREFIX_MODAL_ID = 'settings-modal-prefix';
const COLOR_MODAL_ID = 'settings-modal-color';

export const colorHexToDecimal = (hex: string): number | null => {
  const cleaned = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return null;
  }
  return parseInt(cleaned, 16);
};

@injectable()
export class SettingsInteractions {
  private readonly prefixService: PrefixService;
  private readonly colorService: ColorService;

  constructor(
    @inject(PrefixService) prefixService: PrefixService,
    @inject(ColorService) colorService: ColorService,
  ) {
    this.prefixService = prefixService;
    this.colorService = colorService;

    registerModalHandler(PREFIX_MODAL_ID, async (interaction) => {
      if (!this.isStaff(interaction)) {
        await interaction.reply({
          content: 'You need the `Manage Server` permission to change bot settings.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const clean = interaction.fields.getTextInputValue('prefix').trim().slice(0, 10);
      if (!clean) {
        await interaction.reply({
          content: 'Prefix cannot be empty.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await this.prefixService.setPrefix(interaction.guildId!, clean);
      await interaction.reply({
        content: `Command prefix set to \`${clean}\``,
        flags: MessageFlags.Ephemeral,
      });
    });

    registerModalHandler(COLOR_MODAL_ID, async (interaction) => {
      const value = interaction.fields.getTextInputValue('color').trim();
      if (value.toLowerCase() === 'reset' || value.toLowerCase() === 'default') {
        await this.colorService.setAccentColorAsync(interaction.user.id, null);
        await interaction.reply({
          content: 'Accent color reset to default (blank).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const parsed = colorHexToDecimal(value);
      if (parsed === null) {
        await interaction.reply({
          content: 'Invalid hex color. Use a format like `#3498db` or type `reset`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await this.colorService.setAccentColorAsync(interaction.user.id, parsed);
      await interaction.reply({
        content: `Your embed accent color set to \`#${parsed.toString(16).padStart(6, '0')}\``,
        flags: MessageFlags.Ephemeral,
      });
    });
  }

  private isStaff(
    interaction: ButtonInteraction | import('discord.js').ModalSubmitInteraction,
  ): boolean {
    if (!interaction.inGuild() || !interaction.member) {
      return false;
    }
    try {
      const perms = new PermissionsBitField(interaction.member.permissions as never);
      return (
        perms.has(PermissionsBitField.Flags.ManageGuild) ||
        perms.has(PermissionsBitField.Flags.Administrator)
      );
    } catch {
      return false;
    }
  }

  public async handleSettingsButton(interaction: ButtonInteraction): Promise<void> {
    if (!this.isStaff(interaction)) {
      await interaction.reply({
        content: 'You need the `Manage Server` permission to change bot settings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const action = interaction.customId.slice(SETTINGS_BUTTON_PREFIX.length);

    if (action === 'prefix') {
      const modal = new ModalBuilder()
        .setCustomId(PREFIX_MODAL_ID)
        .setTitle('Change command prefix')
        .addComponents(
          new TextInputBuilder()
            .setCustomId('prefix')
            .setLabel('New prefix (max 10 characters)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setRequired(true),
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'color') {
      const modal = new ModalBuilder()
        .setCustomId(COLOR_MODAL_ID)
        .setTitle('Change embed accent color')
        .addComponents(
          new TextInputBuilder()
            .setCustomId('color')
            .setLabel('Hex color (#3498db) or "reset"')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setPlaceholder('#d51007')
            .setRequired(true),
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'fmmode') {
      await interaction.reply({ content: 'Use `/fmmode` to customize your .fm — embed type, footer, buttons, accent color and small text.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'serverfm') {
      await interaction.reply({ content: 'Use `/settings` Server tab → set guild fmEmbedType via `/servermode` (coming soon). Channel overrides per-channel.', flags: MessageFlags.Ephemeral });
      return;
    }
  }
}

export const buildSettingsPage = async (
  context: ContextModel,
  prefixService: PrefixService,
): Promise<ResponseModel> => {
  const currentPrefix = await prefixService.getPrefix(context.guildId);
  const accentColor = context.accentColor;
  const accentHex = accentColor !== undefined ? `#${accentColor.toString(16).padStart(6, '0')}` : 'Default (blank)';
  const canManage = context.userIsGuildAdmin;
  // FM setting for user
  let fmEmbedName = 'Embed Mini';
  try {
    const di = (await import('tsyringe')).container;
    const UserRepository = (await import('@persistence/repositories/userRepository')).UserRepository;
    const FmSettingService = (await import('@bot/services/fmSettingService')).FmSettingService;
    const userRepo = di.resolve(UserRepository as unknown as Parameters<typeof di.resolve>[0]) as InstanceType<typeof UserRepository>;
    const fmService = di.resolve(FmSettingService as unknown as Parameters<typeof di.resolve>[0]) as InstanceType<typeof FmSettingService>;
    const u = await userRepo.getUserByDiscordUserId(context.discordUserId);
    if (u) {
      const s = await fmService.get(u.userId);
      if (s) fmEmbedName = (FmEmbedTypeNames as Record<number,string>)[s.embedType] ?? fmEmbedName;
    }
  } catch { /* ignore */ }

  const container = new ContainerBuilder();
  if (accentColor !== undefined) container.setAccentColor(accentColor);
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Settings`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Command prefix**\n\`${currentPrefix}\` - used for text commands like \`${currentPrefix}fm\`, \`${currentPrefix}chart\``,
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${SETTINGS_BUTTON_PREFIX}prefix`)
            .setLabel('Edit prefix')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canManage),
        ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Your embed accent color**\n\`${accentHex}\` - used on your charts and responses`,
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${SETTINGS_BUTTON_PREFIX}color`)
            .setLabel('Edit color')
            .setStyle(ButtonStyle.Secondary),
        ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**FM Mode**\n\`${fmEmbedName}\` — controls \`.fm\` layout (6 types, footer, buttons). Use \`/fmmode\``),
        )
        .setButtonAccessory(
          new ButtonBuilder().setCustomId(`${SETTINGS_BUTTON_PREFIX}fmmode`).setLabel('FM Mode').setStyle(ButtonStyle.Secondary),
        ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Server FM Override**\nGuild/Channel can force an embed type for all \`.fm\` in this server`))
        .setButtonAccessory(new ButtonBuilder().setCustomId(`${SETTINGS_BUTTON_PREFIX}serverfm`).setLabel('Server FM').setStyle(ButtonStyle.Secondary).setDisabled(!canManage)),
    );

  const response = new ResponseModel();
  response.setComponentsV2Container(container);
  return response;
};
