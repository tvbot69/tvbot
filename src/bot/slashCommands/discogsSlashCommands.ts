import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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
export class DiscogsSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(DiscogsService) private readonly discogsService: DiscogsService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('discogs')
          .setDescription('Search Discogs for release info, pressings, vinyl & CD catalog')
          .addStringOption((opt) =>
            opt
              .setName('query')
              .setDescription('Artist, album or release title to search for')
              .setRequired(false),
          ),
        executeAsync: (ctx) => this.discogsSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('collection')
          .setDescription('View and manage your physical and digital music collection')
          .addSubcommand((sub) =>
            sub
              .setName('view')
              .setDescription('View your or someone else\'s music collection')
              .addUserOption((opt) =>
                opt.setName('user').setDescription('User whose collection you want to view').setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('add')
              .setDescription('Add a release to your collection')
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(true))
              .addStringOption((opt) => opt.setName('album').setDescription('Album title').setRequired(true))
              .addStringOption((opt) =>
                opt
                  .setName('format')
                  .setDescription('Physical or digital format')
                  .setRequired(false)
                  .addChoices(
                    { name: '💿 Vinyl', value: 'Vinyl' },
                    { name: '💽 CD', value: 'CD' },
                    { name: '📼 Cassette', value: 'Cassette' },
                    { name: '📁 Digital', value: 'Digital' },
                  ),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('remove')
              .setDescription('Remove a release from your collection')
              .addStringOption((opt) => opt.setName('index').setDescription('Item number or ID').setRequired(true)),
          ),
        executeAsync: (ctx) => this.collectionSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('whohas')
          .setDescription('Search for guild members who have an album or artist in their collection')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Artist or album name to search for').setRequired(true),
          ),
        executeAsync: (ctx) => this.whoHasSlashAsync(ctx),
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

  public async discogsSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    let query = ctx.interaction?.options.getString('query')?.trim() || '';

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
          // ignore
        }
      }
    }

    if (!query) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 💿 Discogs Search\nPlease specify a release to search for:\n> \`/discogs query:<artist or album>\``,
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

  public async collectionSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const sub = ctx.interaction?.options.getSubcommand() || 'view';

    if (sub === 'add') {
      const artist = ctx.interaction?.options.getString('artist', true) || '';
      const album = ctx.interaction?.options.getString('album', true) || '';
      const format = (ctx.interaction?.options.getString('format') || 'Vinyl') as 'Vinyl' | 'CD' | 'Cassette' | 'Digital';

      this.discogsService.addToCollection(ctx.discordUserId, artist, album, format);
      const collection = this.discogsService.getCollection(ctx.discordUserId);
      return DiscogsAndImportBuilders.buildCollectionResponse({
        displayName: ctx.discordDisplayName,
        collection,
        prefix: '/',
        accentColor,
      });
    }

    if (sub === 'remove') {
      const index = ctx.interaction?.options.getString('index', true) || '';
      this.discogsService.removeFromCollection(ctx.discordUserId, index);
      const collection = this.discogsService.getCollection(ctx.discordUserId);
      return DiscogsAndImportBuilders.buildCollectionResponse({
        displayName: ctx.discordDisplayName,
        collection,
        prefix: '/',
        accentColor,
      });
    }

    const targetUser = ctx.interaction?.options.getUser('user');
    const targetUserId = targetUser ? targetUser.id : ctx.discordUserId;
    const targetDisplayName = targetUser ? targetUser.displayName : ctx.discordDisplayName;

    const collection = this.discogsService.getCollection(targetUserId);
    return DiscogsAndImportBuilders.buildCollectionResponse({
      displayName: targetDisplayName,
      collection,
      prefix: '/',
      accentColor,
    });
  }

  public async whoHasSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx);
    const query = ctx.interaction?.options.getString('query', true)?.trim() || '';

    const memberIds = ctx.guild?.members.cache
      ? Array.from(ctx.guild.members.cache.keys())
      : [ctx.discordUserId];

    const matches = this.discogsService.findWhoHas(query, memberIds);
    return DiscogsAndImportBuilders.buildWhoHasResponse({ query, matches, accentColor });
  }
}
