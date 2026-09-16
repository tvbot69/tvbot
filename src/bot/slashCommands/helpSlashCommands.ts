import { injectable } from 'tsyringe';
import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { HelpBuilders, type HelpCategory } from '@bot/builders/helpBuilders';

@injectable()
export class HelpSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor() {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('help')
          .setDescription('Displays documentation, guides, and commands for tvbot')
          .addStringOption((option) =>
            option
              .setName('category')
              .setDescription('The command category to display')
              .setRequired(false)
              .addChoices(
                { name: '🏠 Overview & Quick Start', value: 'home' },
                { name: '🎵 Music Stats & Now Playing', value: 'stats' },
                { name: '📊 Charts & Collages', value: 'charts' },
                { name: '🏆 Top Lists', value: 'top' },
                { name: '👑 WhoKnows & Crowns', value: 'whoknows' },
                { name: '🎧 Music Playback', value: 'music' },
                { name: '🎮 Social, Games & Discovery', value: 'social' },
                { name: '⚙️ Settings & Administration', value: 'settings' },
              ),
          ),
        executeAsync: (context) => this.helpAsync(context),
      },
    ];
  }

  private async helpAsync(context: ContextModel): Promise<ResponseModel> {
    const rawCategory = context.interaction?.options.getString('category') ?? undefined;
    const category = HelpBuilders.normalizeCategory(rawCategory);

    return HelpBuilders.buildHelpResponse(
      category,
      context.prefix,
      context.discordUserId,
      context.accentColor,
    );
  }
}
