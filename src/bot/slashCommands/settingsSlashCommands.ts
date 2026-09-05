import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type {
  ISlashCommandModule,
  SlashCommandData,
} from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { buildSettingsPage } from '@bot/interactions/settingsInteractions';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class SettingsSlashCommands implements ISlashCommandModule {
  public commands: ISlashCommandModule['commands'];

  private readonly prefixService: PrefixService;
  private readonly colorService: ColorService;

  constructor(
    @inject(PrefixService) prefixService: PrefixService,
    @inject(ColorService) colorService: ColorService,
  ) {
    this.prefixService = prefixService;
    this.colorService = colorService;

    const data = new SlashCommandBuilder()
      .setName('settings')
      .setDescription('View and manage bot settings for this server');

    this.commands = [
      {
        data: data as SlashCommandData,
        executeAsync: (context) => this.settingsAsync(context),
      },
    ];
  }

  private async settingsAsync(context: ContextModel): Promise<ResponseModel> {
    return buildSettingsPage(context, this.prefixService);
  }
}
