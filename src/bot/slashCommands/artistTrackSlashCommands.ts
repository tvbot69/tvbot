import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { ArtistTrackService } from '@bot/services/artistTrackService';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { UpdateService } from '@bot/services/updateService';

export class ArtistTrackSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];
  constructor(
    private readonly userService: UserService,
    private readonly artistTrackService: ArtistTrackService,
    private readonly lastfmRepository: LastFmRepository,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder().setName('at').setDescription("Your top tracks for an artist").addStringOption(o => o.setName('artist').setDescription('Artist name (defaults to currently playing)').setRequired(false).setAutocomplete(true)) as any,
        executeAsync: (ctx) => this.atAsync(ctx),
      },
    ];
  }

  private async atAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use `/register` first.');

    // Sync latest plays to local DB if stale
    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    let artistName = context.interaction?.options.getString('artist')?.trim() ?? '';
    if (!artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) return GenericEmbedService.buildNotFoundResponse('No recent tracks found.');
      artistName = recent[0]!.artistName;
    } else {
      const search = await this.lastfmRepository.searchArtists(artistName);
      if (search.length > 0) artistName = search[0]!.name;
    }
    const tracks = await this.artistTrackService.getTopTracksForArtist(user.userId, artistName);
    if (!tracks || tracks.length === 0) return GenericEmbedService.buildNotFoundResponse(`No tracks found for artist **${artistName}**.`);
    const totalPlays = await this.artistTrackService.getTotalArtistPlays(user.userId, artistName);
    const distinct = await this.artistTrackService.getDistinctTrackCount(user.userId, artistName);
    const displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? user.userNameLastFm;
    return ArtistTrackBuilders.buildArtistTopTracksResponse(artistName, displayName, tracks, totalPlays, distinct, 0, context.accentColor);
  }
}

