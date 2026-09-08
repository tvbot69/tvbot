import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { injectable } from 'tsyringe';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { FmSettingService } from '@bot/services/fmSettingService';
import { UserService } from '@bot/services/userService';

export const FM_MODE_PREFIX = 'fmmode:';

@injectable()
export class FmModeInteractions {
  constructor(
    private readonly userService: UserService,
    private readonly fmSettingService: FmSettingService,
  ) {}

  public async handle(interaction: StringSelectMenuInteraction): Promise<void> {
    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({ content: 'Connect your Last.fm account first with `/register`.', flags: MessageFlags.Ephemeral });
      return;
    }

    const action = interaction.customId.slice(FM_MODE_PREFIX.length);
    const values = interaction.values;
    switch (action) {
      case 'type':
        await this.fmSettingService.setEmbedType(user.userId, Number(values[0]));
        break;
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
    const response = PlayBuilders.buildFmModeResponse(updated);
    await interaction.update({
      components: [response.componentsV2Container!],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  }
}
