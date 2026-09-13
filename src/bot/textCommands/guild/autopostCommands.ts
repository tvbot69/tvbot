import { inject, injectable } from 'tsyringe';
import { Client, PermissionsBitField, type TextChannel } from 'discord.js';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { AutopostService, type AutopostContentType, type AutopostSchedule } from '@bot/services/autopostService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { AutopostBuilders } from '@bot/builders/autopostBuilders';

@injectable()
export class AutopostCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(AutopostService) private readonly autopostService: AutopostService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(Client) private readonly client: Client,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'autoposts',
        aliases: ['autopost', 'autoposter', 'scheduledposts'],
        executeAsync: (ctx, args) => this.handleAutopostsAsync(ctx, args),
      },
    ];
  }

  private async handleAutopostsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used inside a server.',
      );
    }

    const prefix = await this.prefixService.getPrefix(context.guildId);
    const sub = (args[0] ?? '').toLowerCase();

    // Check staff permissions for modifications
    if (['add', 'remove', 'delete', 'toggle', 'send', 'run'].includes(sub)) {
      if (!context.userIsGuildAdmin) {
        return GenericEmbedService.buildWrongInputResponse(
          'You need the **Manage Server** permission to modify autoposts.',
        );
      }
    }

    if (sub === 'add') {
      return this.addAutopostAsync(context, args.slice(1), prefix);
    }
    if (sub === 'remove' || sub === 'delete') {
      return this.removeAutopostAsync(context, args.slice(1));
    }
    if (sub === 'toggle') {
      return this.toggleAutopostAsync(context, args.slice(1));
    }
    if (sub === 'send' || sub === 'run') {
      return this.sendAutopostAsync(context, args.slice(1));
    }

    // Default: show overview
    const autoposts = await this.autopostService.fetchAutopostsForGuild(context.guildId);
    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return AutopostBuilders.buildAutopostOverview({
      guildName: context.guild?.name ?? 'Server',
      autoposts,
      prefix,
      accentColor,
    });
  }

  private async addAutopostAsync(context: ContextModel, args: string[], prefix: string): Promise<ResponseModel> {
    if (args.length < 2) {
      return GenericEmbedService.buildWrongInputResponse(
        `Usage: \`${prefix}autopost add <topartists|topalbums|toptracks|crowns> <daily|weekly|monthly> [#channel]\``,
      );
    }

    const rawType = (args[0] ?? '').toLowerCase();
    let contentType: AutopostContentType | null = null;
    if (rawType.includes('artist')) contentType = 'TopArtists';
    else if (rawType.includes('album')) contentType = 'TopAlbums';
    else if (rawType.includes('track')) contentType = 'TopTracks';
    else if (rawType.includes('crown')) contentType = 'ServerCrowns';

    if (!contentType) {
      return GenericEmbedService.buildWrongInputResponse(
        'Invalid content type. Choose from: `topartists`, `topalbums`, `toptracks`, or `crowns`.',
      );
    }

    const rawSchedule = (args[1] ?? '').toLowerCase();
    let schedule: AutopostSchedule | null = null;
    if (rawSchedule === 'daily' || rawSchedule === 'day') schedule = 'Daily';
    else if (rawSchedule === 'weekly' || rawSchedule === 'week') schedule = 'Weekly';
    else if (rawSchedule === 'monthly' || rawSchedule === 'month') schedule = 'Monthly';

    if (!schedule) {
      return GenericEmbedService.buildWrongInputResponse(
        'Invalid schedule. Choose from: `daily`, `weekly`, or `monthly`.',
      );
    }

    let channelId = context.interaction?.channelId ?? context.message?.channelId ?? '';
    if (args[2]) {
      const match = args[2].match(/<#(\d+)>/) || args[2].match(/^(\d+)$/);
      if (match && match[1]) channelId = match[1];
    }

    if (!channelId) {
      return GenericEmbedService.buildWrongInputResponse('Could not determine text channel ID.');
    }

    const targetChannel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!targetChannel || !targetChannel.isTextBased()) {
      return GenericEmbedService.buildWrongInputResponse('Could not find that text channel or bot lacks permission to view it.');
    }

    const created = await this.autopostService.createAutopost({
      guildId: context.guildId!,
      channelId,
      contentType,
      schedule,
      enabled: true,
    });

    return GenericEmbedService.buildSuccessResponse(
      `✅ Autopost **#${created.id}** created!\nPosting **${contentType.replace('Top', 'Top ')}** on a **${schedule}** schedule to <#${channelId}>.`,
    );
  }

  private async removeAutopostAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const id = args[0];
    if (!id) {
      return GenericEmbedService.buildWrongInputResponse('Please provide the autopost ID to remove. (e.g. `.autopost remove 1`)');
    }

    const removed = await this.autopostService.removeAutopost(id, context.guildId!);
    if (!removed) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find an autopost with ID **#${id}** in this server.`);
    }

    return GenericEmbedService.buildSuccessResponse(`🗑️ Autopost **#${id}** has been removed.`);
  }

  private async toggleAutopostAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const id = args[0];
    if (!id) {
      return GenericEmbedService.buildWrongInputResponse('Please provide the autopost ID to toggle. (e.g. `.autopost toggle 1`)');
    }

    const updated = await this.autopostService.toggleAutopost(id, context.guildId!);
    if (!updated) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find an autopost with ID **#${id}** in this server.`);
    }

    const statusStr = updated.enabled ? '🟢 Resumed' : '⏸️ Paused';
    return GenericEmbedService.buildSuccessResponse(`Autopost **#${id}** is now ${statusStr}.`);
  }

  private async sendAutopostAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const id = args[0];
    if (!id) {
      return GenericEmbedService.buildWrongInputResponse('Please provide the autopost ID to run. (e.g. `.autopost send 1`)');
    }

    const autoposts = await this.autopostService.getAutopostsForGuild(context.guildId!);
    const target = autoposts.find((a) => a.id === id);
    if (!target) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find an autopost with ID **#${id}** in this server.`);
    }

    const success = await this.autopostService.postAutopost(target, this.client);
    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to post to <#${target.channelId}>. Check channel permissions.`,
      );
    }

    return GenericEmbedService.buildSuccessResponse(`🚀 Test run posted successfully to <#${target.channelId}>!`);
  }
}
