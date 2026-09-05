import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { StaticBuilders } from '@bot/builders/staticBuilders';

export class StaticSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor() {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('ping')
          .setDescription('Checks the bot latency'),
        executeAsync: (context) => this.pingAsync(context),
      },
    ];
  }

  private async pingAsync(context: ContextModel): Promise<ResponseModel> {
    const latency = context.interaction?.client.ws.ping ?? -1;
    return StaticBuilders.buildPingResponse(latency, context.accentColor);
  }
}
