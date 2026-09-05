import { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type StringSelectMenuInteraction } from 'discord.js';
import { injectable } from 'tsyringe';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { FmAccentColor } from '@domain/enums/fmAccentColor';
import { FmSettingService } from '@bot/services/fmSettingService';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { registerModalHandler } from './index';

export const FM_MODE_PREFIX = 'fmmode:';
const CUSTOM_COLOR_MODAL_ID = 'fmmode:custom-color';

@injectable()
export class FmModeInteractions {
  constructor(
    private readonly userService: UserService,
    private readonly fmSettingService: FmSettingService,
    private readonly colorService?: ColorService,
  ) {
    registerModalHandler(CUSTOM_COLOR_MODAL_ID, async (interaction) => {
      const user = await this.userService.getUserByDiscordId(interaction.user.id);
      if (!user) {
        await interaction.reply({ content: 'Connect your Last.fm account first with `/register`.', flags: MessageFlags.Ephemeral });
        return;
      }
      const raw = interaction.fields.getTextInputValue('color').trim().replace(/^#/, '');
      if (!/^[0-9a-f]{6}$/i.test(raw)) {
        await interaction.reply({ content: 'Use a six-digit hex color such as `#d51007`.', flags: MessageFlags.Ephemeral });
        return;
      }
      await this.fmSettingService.setAccentColor(user.userId, FmAccentColor.Custom, `#${raw}`);
      if (this.colorService) {
        await this.colorService.setUserAccentColorAsync(interaction.user.id, parseInt(raw, 16));
      }
      await interaction.reply({ content: `Your .fm accent is now \`#${raw.toLowerCase()}\`.`, flags: MessageFlags.Ephemeral });
    });
  }

  public async handle(interaction: StringSelectMenuInteraction): Promise<void> {
    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({ content: 'Connect your Last.fm account first with `/register`.', flags: MessageFlags.Ephemeral });
      return;
    }

    const action = interaction.customId.slice(FM_MODE_PREFIX.length);
    const values = interaction.values;
    const current = await this.fmSettingService.getOrCreate(user.userId);
    switch (action) {
      case 'type':
        await this.fmSettingService.setEmbedType(user.userId, Number(values[0]));
        break;
      case 'accent': {
        const accent = Number(values[0]);
        if (accent === FmAccentColor.Custom) {
          const modal = new ModalBuilder()
            .setCustomId(CUSTOM_COLOR_MODAL_ID)
            .setTitle('Custom .fm accent color')
            .addComponents(
              new TextInputBuilder()
                .setCustomId('color')
                .setLabel('Hex color')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(current.customColor ?? '#d51007')
                .setMaxLength(7)
                .setRequired(true),
            );
          await interaction.showModal(modal);
          return;
        }
        await this.fmSettingService.setAccentColor(
          user.userId,
          accent,
          null,
        );
        if (this.colorService) {
          if (accent === FmAccentColor.LastFmRed) {
            await this.colorService.setUserAccentColorAsync(interaction.user.id, DiscordConstants.LastFmColorRed);
          } else {
            await this.colorService.setUserAccentColorAsync(interaction.user.id, null);
          }
        }
        break;
      }
      case 'text':
        await this.fmSettingService.setSmallTextType(user.userId, Number(values[0]));
        break;
      case 'footer':
        await this.fmSettingService.setFooterOptions(user.userId, values.reduce((total, value) => total | BigInt(value), BigInt(0)));
        break;
      case 'buttons':
        await this.fmSettingService.setButtons(user.userId, values.reduce((total, value) => total | BigInt(value), BigInt(0)));
        break;
      default:
        return;
    }

    const updated = await this.fmSettingService.getOrCreate(user.userId);
    const accentColor = await this.colorService?.getUserAccentColorAsync(interaction.user.id);
    const response = PlayBuilders.buildFmModeResponse(updated, accentColor);
    await interaction.update({
      components: [response.componentsV2Container!],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  }
}
