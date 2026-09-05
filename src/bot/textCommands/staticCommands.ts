import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { StaticBuilders } from '@bot/builders/staticBuilders';

export class StaticCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor() {
    this.commands = [
      {
        name: 'ping',
        executeAsync: (context, _args) => this.pingAsync(context),
      },
    ];
  }

  private async pingAsync(context: ContextModel): Promise<ResponseModel> {
    const latency = context.message?.client.ws.ping ?? -1;
    return StaticBuilders.buildPingResponse(latency, context.accentColor);
  }
}
