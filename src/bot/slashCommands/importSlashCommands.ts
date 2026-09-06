import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { ImportService } from '@bot/services/importService';
import { DiscogsAndImportBuilders } from '@bot/builders/discogsAndImportBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';

@injectable()
export class ImportSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(ImportService) private readonly importService: ImportService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('import')
          .setDescription('Import your complete Spotify or Apple Music streaming history (Zero Paywalls)')
          .addAttachmentOption((opt) =>
            opt
              .setName('file')
              .setDescription('Spotify endsong_*.json / StreamingHistory*.json file')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('source')
              .setDescription('Streaming service guide')
              .setRequired(false)
              .addChoices(
                { name: '🟢 Spotify Guide', value: 'spotify' },
                { name: '🍏 Apple Music Guide', value: 'apple' },
                { name: '📥 Universal Overview', value: 'all' },
              ),
          ),
        executeAsync: (ctx) => this.importSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('importmodify')
          .setDescription('Manage or reset your imported streaming scrobbles'),
        executeAsync: (ctx) => this.modifyImportSlashAsync(ctx),
      },
    ];
  }

  private async getAccentColor(ctx: ContextModel): Promise<number> {
    if (this.colorService) {
      const color = await this.colorService.getAccentColorAsync(ctx.guildId);
      if (color) return color;
    }
    return DiscordConstants.SuccessColorGreen;
  }

  public async importSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return GenericEmbedService.buildWrongInputResponse(
        'You have not connected your Last.fm account yet. Connect it with `/login`.',
      );
    }

    const attachment = ctx.interaction?.options.getAttachment('file');
    if (attachment) {
      try {
        const fileRes = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) });
        if (!fileRes.ok) {
          throw new Error(`Failed to download attached file (${fileRes.status} ${fileRes.statusText})`);
        }

        const fileContent = await fileRes.text();
        const summary = await this.importService.parseAndImport(user.userId, fileContent);

        return DiscogsAndImportBuilders.buildImportSummaryResponse({
          displayName: ctx.discordDisplayName,
          summary,
          accentColor,
        });
      } catch (err: any) {
        const errorContainer = new ContainerBuilder();
        errorContainer.setAccentColor(DiscordConstants.ErrorColorRed);
        errorContainer.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### ❌ Import Error\n${err?.message || 'Could not process imported file.'}`,
          ),
        );
        const res = new ResponseModel(DiscordConstants.ErrorColorRed);
        res.commandResponse = CommandResponse.Ok;
        res.setComponentsV2Container(errorContainer);
        return res;
      }
    }

    const source = (ctx.interaction?.options.getString('source') || 'all') as 'spotify' | 'apple' | 'all';
    const instructions = this.importService.getInstructions(source);
    return DiscogsAndImportBuilders.buildImportInstructionsResponse({
      instructions,
      accentColor,
    });
  }

  public async modifyImportSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return GenericEmbedService.buildWrongInputResponse(
        'You have not connected your Last.fm account yet. Connect it with `/login`.',
      );
    }

    const success = await this.importService.resetImport(user.userId);
    return DiscogsAndImportBuilders.buildImportModifyResponse({
      success,
      accentColor,
    });
  }
}
