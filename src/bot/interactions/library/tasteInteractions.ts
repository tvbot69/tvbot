import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { TasteService } from '@bot/services/library/tasteService';
import { TasteBuilders } from '@bot/builders/library/tasteBuilders';
import { ColorService } from '@bot/services/system/colorService';

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
      // CORRECT AS IS, and the expired-session sentence is the TRUE one. The
      // taste session is a bounded in-memory cache keyed by the `cacheKey` baked
      // into the button; a miss means the session aged out or the process
      // restarted, and there is no database read that could have failed. Nothing
      // here can make a claim about two users' taste, because no taste data is
      // being read at all. The `.catch` is Discord rejecting the reply, which
      // leaves the user on the tab they were already looking at.
      await interaction.reply({
        content: 'This comparison session has expired. Run `.taste` again to refresh.',
        ephemeral: true,
      }).catch(() => undefined);
      return;
    }

    const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

    const response = TasteBuilders.buildTasteResponse(tasteData, tabIndex, amount, accentColor);
    if (response.componentsV2Container) {
      // CORRECT AS IS: transport. `tasteData` came from the cache above and
      // every number on the card is derived from it, so the update is a pure
      // render - the fallback to `deferUpdate` acknowledges without editing,
      // which is the "leave the page alone" rule that every handler here follows.
      await interaction.update({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      }).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }
}
