import { injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { HelpBuilders } from '@bot/builders/helpBuilders';

@injectable()
export class HelpCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor() {
    this.commands = [
      {
        name: 'help',
        aliases: ['commands', 'h', 'cmds'],
        executeAsync: (context, args) => this.helpAsync(context, args),
      },
    ];
  }

  private async helpAsync(context: ContextModel, args?: string[]): Promise<ResponseModel> {
    const rawCategory = args && args.length > 0 ? args[0] : undefined;
    const category = HelpBuilders.normalizeCategory(rawCategory);

    return HelpBuilders.buildHelpResponse(
      category,
      context.prefix,
      context.discordUserId,
      context.accentColor,
    );
  }
}
