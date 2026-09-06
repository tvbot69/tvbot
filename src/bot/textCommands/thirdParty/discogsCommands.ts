import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { DiscogsService } from '@bot/services/discogsService';
import { DiscogsAndImportBuilders } from '@bot/builders/discogsAndImportBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';

@injectable()
export class DiscogsCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(DiscogsService) private readonly discogsService: DiscogsService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'discogs',
        aliases: ['discogssearch', 'discogsrelease'],
        executeAsync: (ctx, args) => this.discogsAsync(ctx, args),
      },
      {
        name: 'collection',
        aliases: ['coll', 'vinyl', 'discogscollection'],
        executeAsync: (ctx, args) => this.collectionAsync(ctx, args),
      },
      {
        name: 'whohas',
        aliases: ['wh', 'whohasvinyl'],
        executeAsync: (ctx, args) => this.whoHasAsync(ctx, args),
      },
    ];
  }

  private async getAccentColor(ctx: ContextModel): Promise<number> {
    if (this.colorService) {
      const color = await this.colorService.getAccentColorAsync(ctx.guildId);
      if (color) return color;
    }
    return DiscordConstants.LastFmColorBlue;
  }

  public async discogsAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    let query = args.join(' ').trim();

    if (!query) {
      const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
      if (user?.userNameLastFm) {
        try {
          const recents = await this.lastFmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1);
          if (recents && recents.length > 0 && recents[0]) {
            const track = recents[0];
            query = `${track.artistName} ${track.name}`;
          }
        } catch {
          // ignore error
        }
      }
    }

    if (!query) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 💿 Discogs Search\n` +
          `Search the global Discogs catalog for vinyl, CD, and cassette pressings.\n\n` +
          `**Usage:**\n` +
          `> \`${ctx.prefix}discogs <artist - album / release>\`\n` +
          `> Example: \`${ctx.prefix}discogs Daft Punk - Discovery\``,
        ),
      );
      const res = new ResponseModel(accentColor);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }

    const release = await this.discogsService.searchRelease(query);
    if (!release) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`No Discogs release found for **"${query}"**.`),
      );
      const res = new ResponseModel(accentColor);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }

    return DiscogsAndImportBuilders.buildDiscogsReleaseResponse({ release, accentColor });
  }

  public async collectionAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const sub = args[0]?.toLowerCase();

    if (sub === 'add') {
      const remaining = args.slice(1).join(' ').trim();
      let format: 'Vinyl' | 'CD' | 'Cassette' | 'Digital' = 'Vinyl';
      let rest = remaining;

      const lower = remaining.toLowerCase();
      if (lower.endsWith('cd')) {
        format = 'CD';
        rest = remaining.slice(0, -2).trim();
      } else if (lower.endsWith('cassette')) {
        format = 'Cassette';
        rest = remaining.slice(0, -8).trim();
      } else if (lower.endsWith('digital')) {
        format = 'Digital';
        rest = remaining.slice(0, -7).trim();
      } else if (lower.endsWith('vinyl')) {
        format = 'Vinyl';
        rest = remaining.slice(0, -5).trim();
      }

      const parts = rest.split(' - ');
      const artist = parts[0]?.trim() || 'Unknown Artist';
      const album = parts.slice(1).join(' - ').trim() || parts[0]?.trim() || 'Unknown Album';

      this.discogsService.addToCollection(ctx.discordUserId, artist, album, format);
      const collection = this.discogsService.getCollection(ctx.discordUserId);
      return DiscogsAndImportBuilders.buildCollectionResponse({
        displayName: ctx.discordDisplayName,
        collection,
        prefix: ctx.prefix,
        accentColor,
      });
    }

    if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
      const idOrIdx = args[1]?.trim();
      if (idOrIdx) {
        this.discogsService.removeFromCollection(ctx.discordUserId, idOrIdx);
      }
      const collection = this.discogsService.getCollection(ctx.discordUserId);
      return DiscogsAndImportBuilders.buildCollectionResponse({
        displayName: ctx.discordDisplayName,
        collection,
        prefix: ctx.prefix,
        accentColor,
      });
    }

    let targetUserId = ctx.discordUserId;
    let targetDisplayName = ctx.discordDisplayName;

    if (args.length > 0 && args[0]) {
      const mentionMatch = args[0].match(/<@!?(\d+)>/);
      if (mentionMatch && mentionMatch[1]) {
        targetUserId = mentionMatch[1];
        targetDisplayName = `User ${targetUserId}`;
      }
    }

    const collection = this.discogsService.getCollection(targetUserId);
    return DiscogsAndImportBuilders.buildCollectionResponse({
      displayName: targetDisplayName,
      collection,
      prefix: ctx.prefix,
      accentColor,
    });
  }

  public async whoHasAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const query = args.join(' ').trim();

    if (!query) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🔍 Collection WhoHas\nFind which server members have a release in their vinyl/CD collection.\n\n` +
          `**Usage:**\n` +
          `> \`${ctx.prefix}whohas <artist or album>\`\n` +
          `> Example: \`${ctx.prefix}whohas OK Computer\``,
        ),
      );
      const res = new ResponseModel(accentColor);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }

    const memberIds = ctx.guild?.members.cache
      ? Array.from(ctx.guild.members.cache.keys())
      : [ctx.discordUserId];

    const matches = this.discogsService.findWhoHas(query, memberIds);
    return DiscogsAndImportBuilders.buildWhoHasResponse({ query, matches, accentColor });
  }
}
