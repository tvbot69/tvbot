import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { GameService } from '@bot/services/gameService';
import { GameBuilders } from '@bot/builders/gameBuilders';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class GameInteractions {
  constructor(
    @inject(GameService) private readonly gameService: GameService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('game:')) return;

    const parts = customId.split(':');
    const action = parts[1]; // 'hint' | 'reshuffle' | 'giveup'
    const sessionId = parts[2]!;

    const session = this.gameService.getActiveGameById(sessionId);
    if (!session || session.ended) {
      await interaction.reply({
        content: 'This game session has already ended.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const accentColor = interaction.guildId && this.colorService
      ? await this.colorService.getAccentColorAsync(interaction.guildId)
      : null;

    if (action === 'giveup') {
      const endedSession = this.gameService.giveUp(sessionId);
      if (!endedSession) {
        await interaction.reply({
          content: 'Game already completed.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const response = GameBuilders.buildGameGiveUpResponse(endedSession, accentColor);
      if (response.componentsV2Container) {
        await interaction.update({
          components: [response.componentsV2Container as any],
          files: [],
        });
      }
      return;
    }

    if (action === 'reshuffle') {
      const newDisplay = this.gameService.reshuffle(sessionId);
      if (!newDisplay) {
        await interaction.reply({
          content: 'Cannot reshuffle this game.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const response = GameBuilders.buildJumbleStartResponse(session, accentColor);
      if (response.componentsV2Container) {
        await interaction.update({
          components: [response.componentsV2Container as any],
        });
      }
      return;
    }

    if (action === 'hint') {
      const hintResult = this.gameService.nextHint(sessionId);
      if (!hintResult) {
        await interaction.reply({
          content: 'No more hints available for this game!',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (session.type === 'pixel' && session.coverUrl) {
        await interaction.deferUpdate();
        const enhancedBuffer = await this.gameService.pixelateCover(
          session.coverUrl,
          session.blurLevel,
        );
        const response = GameBuilders.buildPixelStartResponse(session, enhancedBuffer, accentColor);
        if (response.componentsV2Container) {
          await interaction.editReply({
            files: [{ attachment: enhancedBuffer, name: 'pixel-cover.png' }],
            components: [response.componentsV2Container as any],
          });
        }
        return;
      }

      const response = GameBuilders.buildJumbleStartResponse(session, accentColor);
      if (response.componentsV2Container) {
        await interaction.update({
          components: [response.componentsV2Container as any],
        });
      }
    }
  }
}
