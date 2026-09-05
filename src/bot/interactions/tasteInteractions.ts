import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { TasteService } from '@bot/services/tasteService';
import { TasteBuilders } from '@bot/builders/tasteBuilders';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class TasteInteractions {
  constructor(
    @inject(TasteService) private readonly tasteService: TasteService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('taste-tab:')) return;

    // taste-tab:cacheKey:tabIndex:u1:u2:period:amount
    const parts = customId.split(':');
    if (parts.length < 7) return;

    const cacheKey = parts[1]!;
    const tabIndex = parseInt(parts[2]!, 10) || 0;
    const amount = parseInt(parts[6]!, 10) || 14;

    const tasteData = await this.tasteService.getCachedTasteSession(cacheKey);
    if (!tasteData) {
      await interaction.reply({
        content: 'This comparison session has expired. Run `.taste` again to refresh.',
        ephemeral: true,
      }).catch(() => undefined);
      return;
    }

    const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

    const response = TasteBuilders.buildTasteResponse(tasteData, tabIndex, amount, accentColor);
    if (response.componentsV2Container) {
      await (interaction as any).update({
        components: [response.componentsV2Container as any],
        flags: MessageFlags.IsComponentsV2,
      } as any).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }
}
