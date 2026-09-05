import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { buildSettingsPage } from '@bot/interactions/settingsInteractions';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class SettingsCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly prefixService: PrefixService;
  private readonly colorService: ColorService;

  constructor(
    @inject(PrefixService) prefixService: PrefixService,
    @inject(ColorService) colorService: ColorService,
  ) {
    this.prefixService = prefixService;
    this.colorService = colorService;

    this.commands = [
      {
        name: 'settings',
        aliases: ['config', 'prefix'],
        executeAsync: (context, _args) => this.settingsAsync(context),
      },
    ];
  }

  private async settingsAsync(context: ContextModel): Promise<ResponseModel> {
    return buildSettingsPage(context, this.prefixService);
  }
}
