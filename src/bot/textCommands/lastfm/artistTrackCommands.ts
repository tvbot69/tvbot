import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { ArtistTrackService } from '@bot/services/artistTrackService';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { UpdateService } from '@bot/services/updateService';

export class ArtistTrackCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];
  constructor(
    private readonly userService: UserService,
    private readonly artistTrackService: ArtistTrackService,
    private readonly lastfmRepository: LastFmRepository,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      { name: 'artisttracks', aliases: ['at', 'att', 'artisttrack', 'artisttoptracks', 'favs'], executeAsync: (ctx, args) => this.atAsync(ctx, args.join(' ')) },
    ];
  }

  private async atAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use the register command first.');

    // Sync latest plays to local DB if stale
    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    let artistName = raw.trim();
    if (!artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) return GenericEmbedService.buildNotFoundResponse('No recent tracks found.');
      artistName = recent[0]!.artistName;
    } else {
      // Try to resolve via Last.fm search for correct casing
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

