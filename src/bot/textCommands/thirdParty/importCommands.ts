import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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
export class ImportCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(ImportService) private readonly importService: ImportService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'import',
        aliases: [
          'spotifyimport',
          'importspotify',
          'appleimport',
          'applemusicimport',
          'importapple',
          'importapplemusic',
          'imports',
        ],
        executeAsync: (ctx, args) => this.importAsync(ctx, args),
      },
      {
        name: 'importmodify',
        aliases: ['modifyimport', 'importsmodify', 'modifyimports'],
        executeAsync: (ctx) => this.modifyImportAsync(ctx),
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

  public async importAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return GenericEmbedService.buildWrongInputResponse(
        `You have not connected your Last.fm account yet. Connect it with \`${ctx.prefix}login\`.`,
      );
    }

    // Check for message attachment
    const attachment = ctx.message?.attachments?.first();
    if (attachment && (attachment.name?.endsWith('.json') || attachment.contentType?.includes('json'))) {
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

    // Otherwise show instructions
    const fullInvocation = (ctx.args?.[0] || args.join(' ') || '').toLowerCase();
    let source: 'spotify' | 'apple' | 'all' = 'all';
    if (fullInvocation.includes('spotify')) {
      source = 'spotify';
    } else if (fullInvocation.includes('apple')) {
      source = 'apple';
    }

    const instructions = this.importService.getInstructions(source);
    return DiscogsAndImportBuilders.buildImportInstructionsResponse({
      instructions,
      accentColor,
    });
  }

  public async modifyImportAsync(ctx: ContextModel): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return GenericEmbedService.buildWrongInputResponse(
        `You have not connected your Last.fm account yet. Connect it with \`${ctx.prefix}login\`.`,
      );
    }

    const success = await this.importService.resetImport(user.userId);
    return DiscogsAndImportBuilders.buildImportModifyResponse({
      success,
      accentColor,
    });
  }
}
