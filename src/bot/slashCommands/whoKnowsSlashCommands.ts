import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { ArtworkService } from '@bot/services/artworkService';
import { ArtistsService } from '@bot/services/artistsService';
import { AlbumService } from '@bot/services/albumService';
import { TrackService } from '@bot/services/trackService';
import { FriendsService } from '@bot/services/friendsService';
import { WhoKnowsArtistService } from '@bot/services/whoKnows/whoKnowsArtistService';
import { WhoKnowsTrackService } from '@bot/services/whoKnows/whoKnowsTrackService';
import { WhoKnowsAlbumService } from '@bot/services/whoKnows/whoKnowsAlbumService';
import { WhoKnowsPlayService } from '@bot/services/whoKnows/whoKnowsPlayService';
import { WhoKnowsBuilders } from '@bot/builders/whoKnowsBuilders';
import { WhoKnowsService } from '@bot/services/whoKnows/whoKnowsService';
import { UpdateService } from '@bot/services/updateService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';

const lastfmArtistUrl = (artist: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;

const lastfmTrackUrl = (artist: string, track: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

const lastfmAlbumUrl = (artist: string, album: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;

export class WhoKnowsSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  private readonly userService: UserService;
  private readonly artworkService: ArtworkService;
  private readonly artistsService: ArtistsService;
  private readonly albumService: AlbumService;
  private readonly trackService: TrackService;
  private readonly friendsService: FriendsService;
  private readonly whoKnowsArtistService: WhoKnowsArtistService;
  private readonly whoKnowsTrackService: WhoKnowsTrackService;
  private readonly whoKnowsAlbumService: WhoKnowsAlbumService;
  private readonly whoKnowsPlayService: WhoKnowsPlayService;
  private readonly lastfmRepository: ILastfmRepository;
  private readonly updateService: UpdateService;

  constructor(
    userService: UserService,
    artworkService: ArtworkService,
    artistsService: ArtistsService,
    albumService: AlbumService,
    trackService: TrackService,
    friendsService: FriendsService,
    whoKnowsArtistService: WhoKnowsArtistService,
    whoKnowsTrackService: WhoKnowsTrackService,
    whoKnowsAlbumService: WhoKnowsAlbumService,
    whoKnowsPlayService: WhoKnowsPlayService,
    lastfmRepository: ILastfmRepository,
    updateService: UpdateService,
  ) {
    this.userService = userService;
    this.artworkService = artworkService;
    this.artistsService = artistsService;
    this.albumService = albumService;
    this.trackService = trackService;
    this.friendsService = friendsService;
    this.whoKnowsArtistService = whoKnowsArtistService;
    this.whoKnowsTrackService = whoKnowsTrackService;
    this.whoKnowsAlbumService = whoKnowsAlbumService;
    this.whoKnowsPlayService = whoKnowsPlayService;
    this.lastfmRepository = lastfmRepository;
    this.updateService = updateService;

    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('whoknows')
          .setDescription('Check who knows music in this server')
          .addSubcommand((sub) =>
            sub
              .setName('artist')
              .setDescription('Check who knows an artist in this server')
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addIntegerOption((opt) =>
                opt
                  .setName('mode')
                  .setDescription('Response layout')
                  .addChoices(
                    { name: 'Embed (Default)', value: WhoKnowsMode.Default },
                    { name: 'Pagination', value: WhoKnowsMode.Pagination },
                  ),
              )
              .addBooleanOption((opt) => opt.setName('filter_disabled').setDescription('Disable activity filters')),
          )
          .addSubcommand((sub) =>
            sub
              .setName('track')
              .setDescription('Check who knows a track in this server')
              .addStringOption((opt) => opt.setName('track').setDescription('Track name (or Artist | Track)').setRequired(false))
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addIntegerOption((opt) =>
                opt
                  .setName('mode')
                  .setDescription('Response layout')
                  .addChoices(
                    { name: 'Embed (Default)', value: WhoKnowsMode.Default },
                    { name: 'Pagination', value: WhoKnowsMode.Pagination },
                  ),
              )
              .addBooleanOption((opt) => opt.setName('filter_disabled').setDescription('Disable activity filters')),
          )
          .addSubcommand((sub) =>
            sub
              .setName('album')
              .setDescription('Check who knows an album in this server')
              .addStringOption((opt) => opt.setName('album').setDescription('Album name (or Artist | Album)').setRequired(false))
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addIntegerOption((opt) =>
                opt
                  .setName('mode')
                  .setDescription('Response layout')
                  .addChoices(
                    { name: 'Embed (Default)', value: WhoKnowsMode.Default },
                    { name: 'Pagination', value: WhoKnowsMode.Pagination },
                  ),
              )
              .addBooleanOption((opt) => opt.setName('filter_disabled').setDescription('Disable activity filters')),
          ),
        executeAsync: (context) => {
          const sub = context.interaction?.options.getSubcommand() || 'artist';
          if (sub === 'track') return this.whoKnowsTrackAsync(context);
          if (sub === 'album') return this.whoKnowsAlbumAsync(context);
          return this.whoKnowsArtistAsync(context);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('friendswhoknow')
          .setDescription('Check which friends know music')
          .addSubcommand((sub) =>
            sub
              .setName('artist')
              .setDescription('Check which friends know an artist')
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addIntegerOption((opt) =>
                opt
                  .setName('mode')
                  .setDescription('Response layout')
                  .addChoices(
                    { name: 'Embed (Default)', value: WhoKnowsMode.Default },
                    { name: 'Pagination', value: WhoKnowsMode.Pagination },
                  ),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('track')
              .setDescription('Check which friends know a track')
              .addStringOption((opt) => opt.setName('track').setDescription('Track name').setRequired(false))
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addIntegerOption((opt) =>
                opt
                  .setName('mode')
                  .setDescription('Response layout')
                  .addChoices(
                    { name: 'Embed (Default)', value: WhoKnowsMode.Default },
                    { name: 'Pagination', value: WhoKnowsMode.Pagination },
                  ),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('album')
              .setDescription('Check which friends know an album')
              .addStringOption((opt) => opt.setName('album').setDescription('Album name').setRequired(false))
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addIntegerOption((opt) =>
                opt
                  .setName('mode')
                  .setDescription('Response layout')
                  .addChoices(
                    { name: 'Embed (Default)', value: WhoKnowsMode.Default },
                    { name: 'Pagination', value: WhoKnowsMode.Pagination },
                  ),
              ),
          ),
        executeAsync: (context) => {
          const sub = context.interaction?.options.getSubcommand() || 'artist';
          if (sub === 'track') return this.friendsWhoKnowTrackAsync(context);
          if (sub === 'album') return this.friendsWhoKnowAlbumAsync(context);
          return this.friendsWhoKnowArtistAsync(context);
        },
      },
    ];
  }

  private checkSync(user: User): void {
    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }
  }

  private async whoKnowsArtistAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    this.checkSync(user);

    const rawArtist = context.interaction?.options.getString('artist')?.trim();
    const mode = (context.interaction?.options.getInteger('mode') as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const filterDisabled = context.interaction?.options.getBoolean('filter_disabled') ?? false;

    let artistName = rawArtist;
    let livePlaycount: number | undefined;

    if (!artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
    }

    const artistInfo = await this.artistsService.getArtistInfo(artistName, user.userNameLastFm);
    if (artistInfo?.userPlayCount !== undefined) {
      livePlaycount = artistInfo.userPlayCount;
    }

    const resolvedName = artistInfo?.name ?? artistName;
    const result = await this.whoKnowsArtistService.getFilteredUsersForArtist(
      context.guild,
      user,
      resolvedName,
      livePlaycount,
      filterDisabled,
    );

    const [imgUrl, alsoPlaying, closeFriends] = await Promise.all([
      this.artworkService.getArtistImageUrl(resolvedName),
      this.whoKnowsPlayService.getGuildAlsoPlayingArtist(user.userId, result.guildUsers, resolvedName),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `${resolvedName} in ${context.guild.name}`;
    const url = lastfmArtistUrl(resolvedName);

    return WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      result.filteredUsersWithArtist,
      result.filterStats,
      alsoPlaying,
      result.genres,
      closeFriends,
      mode,
      result.crownModel?.crownResult ?? undefined,
    );
  }

  private async whoKnowsTrackAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    this.checkSync(user);

    const rawTrack = context.interaction?.options.getString('track')?.trim();
    const rawArtist = context.interaction?.options.getString('artist')?.trim();
    const mode = (context.interaction?.options.getInteger('mode') as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const filterDisabled = context.interaction?.options.getBoolean('filter_disabled') ?? false;

    let trackName = rawTrack ?? '';
    let artistName = rawArtist ?? '';
    let livePlaycount: number | undefined;

    if (!trackName && !artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
      trackName = recent[0]!.name;
    } else if (trackName.includes('|')) {
      const parts = trackName.split('|').map((s) => s.trim());
      artistName = parts[0]!;
      trackName = parts[1]!;
    }

    const trackInfo = await this.trackService.getTrackInfo(trackName, artistName, user.userNameLastFm);
    if (trackInfo?.userPlayCount !== undefined) {
      livePlaycount = trackInfo.userPlayCount;
    }

    const resolvedArtist = trackInfo?.artistName ?? artistName;
    const resolvedTrack = trackInfo?.name ?? trackName;

    const result = await this.whoKnowsTrackService.getFilteredUsersForTrack(
      context.guild,
      user,
      resolvedArtist,
      resolvedTrack,
      livePlaycount,
      filterDisabled,
    );

    const [imgUrl, alsoPlaying, closeFriends] = await Promise.all([
      this.artworkService.getTrackCoverUrl(resolvedTrack, resolvedArtist),
      this.whoKnowsPlayService.getGuildAlsoPlayingTrack(user.userId, result.guildUsers, resolvedArtist, resolvedTrack),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `${resolvedTrack} by ${resolvedArtist} in ${context.guild.name}`;
    const url = lastfmTrackUrl(resolvedArtist, resolvedTrack);

    return WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      result.filteredUsersWithTrack,
      result.filterStats,
      alsoPlaying,
      undefined,
      closeFriends,
      mode,
    );
  }

  private async whoKnowsAlbumAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    this.checkSync(user);

    const rawAlbum = context.interaction?.options.getString('album')?.trim();
    const rawArtist = context.interaction?.options.getString('artist')?.trim();
    const mode = (context.interaction?.options.getInteger('mode') as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const filterDisabled = context.interaction?.options.getBoolean('filter_disabled') ?? false;

    let albumName = rawAlbum ?? '';
    let artistName = rawArtist ?? '';
    let livePlaycount: number | undefined;

    if (!albumName && !artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      if (!recent[0]!.albumName) {
        return GenericEmbedService.buildNotFoundResponse('No album found on your current track.');
      }
      artistName = recent[0]!.artistName;
      albumName = recent[0]!.albumName;
    } else if (albumName.includes('|')) {
      const parts = albumName.split('|').map((s) => s.trim());
      artistName = parts[0]!;
      albumName = parts[1]!;
    }

    const albumInfo = await this.albumService.getAlbumInfo(artistName, albumName, user.userNameLastFm);
    if (albumInfo?.userPlayCount !== undefined) {
      livePlaycount = albumInfo.userPlayCount;
    }

    const resolvedArtist = albumInfo?.artistName ?? artistName;
    const resolvedAlbum = albumInfo?.name ?? albumName;

    const result = await this.whoKnowsAlbumService.getFilteredUsersForAlbum(
      context.guild,
      user,
      resolvedArtist,
      resolvedAlbum,
      livePlaycount,
      filterDisabled,
    );

    const [imgUrl, alsoPlaying, closeFriends] = await Promise.all([
      this.artworkService.getAlbumCoverUrl(resolvedAlbum, resolvedArtist),
      this.whoKnowsPlayService.getGuildAlsoPlayingAlbum(user.userId, result.guildUsers, resolvedArtist, resolvedAlbum),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `${resolvedAlbum} by ${resolvedArtist} in ${context.guild.name}`;
    const url = lastfmAlbumUrl(resolvedArtist, resolvedAlbum);

    return WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      result.filteredUsersWithAlbum,
      result.filterStats,
      alsoPlaying,
      undefined,
      closeFriends,
      mode,
    );
  }

  private async friendsWhoKnowArtistAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    this.checkSync(user);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    if (friends.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(
        `You have not added any friends yet. Add friends using \`/addfriend <username>\`.`,
      );
    }

    const rawArtist = context.interaction?.options.getString('artist')?.trim();
    const mode = (context.interaction?.options.getInteger('mode') as WhoKnowsMode) ?? WhoKnowsMode.Default;

    let artistName = rawArtist;
    if (!artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
    }

    const artistInfo = await this.artistsService.getArtistInfo(artistName, user.userNameLastFm);
    const resolvedName = artistInfo?.name ?? artistName;

    const friendUsers = await this.whoKnowsArtistService.getFriendUsersForArtists(
      context.guild,
      user.userId,
      resolvedName,
    );

    const requesterMember = context.guild?.members.cache.get(user.discordUserId);
    const usersWithCaller = WhoKnowsService.addOrReplaceUserToIndexList(
      friendUsers,
      user,
      requesterMember?.displayName,
      artistInfo?.userPlayCount,
    );

    const [imgUrl, closeFriends] = await Promise.all([
      this.artworkService.getArtistImageUrl(resolvedName),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `Friends who know ${resolvedName}`;
    const url = lastfmArtistUrl(resolvedName);
    const footerExtra = `Friends who know for ${context.member?.displayName ?? user.userNameLastFm}`;

    return WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      usersWithCaller,
      undefined,
      undefined,
      undefined,
      closeFriends,
      mode,
      footerExtra,
    );
  }

  private async friendsWhoKnowTrackAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    this.checkSync(user);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    if (friends.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(
        `You have not added any friends yet. Add friends using \`/addfriend <username>\`.`,
      );
    }

    const rawTrack = context.interaction?.options.getString('track')?.trim();
    const rawArtist = context.interaction?.options.getString('artist')?.trim();
    const mode = (context.interaction?.options.getInteger('mode') as WhoKnowsMode) ?? WhoKnowsMode.Default;

    let trackName = rawTrack ?? '';
    let artistName = rawArtist ?? '';

    if (!trackName && !artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
      trackName = recent[0]!.name;
    } else if (trackName.includes('|')) {
      const parts = trackName.split('|').map((s) => s.trim());
      artistName = parts[0]!;
      trackName = parts[1]!;
    }

    const trackInfo = await this.trackService.getTrackInfo(trackName, artistName, user.userNameLastFm);
    const resolvedArtist = trackInfo?.artistName ?? artistName;
    const resolvedTrack = trackInfo?.name ?? trackName;

    const friendUsers = await this.whoKnowsTrackService.getFriendUsersForTrack(
      context.guild,
      user.userId,
      resolvedArtist,
      resolvedTrack,
    );

    const requesterMember = context.guild?.members.cache.get(user.discordUserId);
    const usersWithCaller = WhoKnowsService.addOrReplaceUserToIndexList(
      friendUsers,
      user,
      requesterMember?.displayName,
      trackInfo?.userPlayCount,
    );

    const [imgUrl, closeFriends] = await Promise.all([
      this.artworkService.getTrackCoverUrl(resolvedTrack, resolvedArtist),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `Friends who know ${resolvedTrack} by ${resolvedArtist}`;
    const url = lastfmTrackUrl(resolvedArtist, resolvedTrack);
    const footerExtra = `Friends who know for ${context.member?.displayName ?? user.userNameLastFm}`;

    return WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      usersWithCaller,
      undefined,
      undefined,
      undefined,
      closeFriends,
      mode,
      footerExtra,
    );
  }

  private async friendsWhoKnowAlbumAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    this.checkSync(user);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    if (friends.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(
        `You have not added any friends yet. Add friends using \`/addfriend <username>\`.`,
      );
    }

    const rawAlbum = context.interaction?.options.getString('album')?.trim();
    const rawArtist = context.interaction?.options.getString('artist')?.trim();
    const mode = (context.interaction?.options.getInteger('mode') as WhoKnowsMode) ?? WhoKnowsMode.Default;

    let albumName = rawAlbum ?? '';
    let artistName = rawArtist ?? '';

    if (!albumName && !artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      if (!recent[0]!.albumName) {
        return GenericEmbedService.buildNotFoundResponse('No album found on your current track.');
      }
      artistName = recent[0]!.artistName;
      albumName = recent[0]!.albumName;
    } else if (albumName.includes('|')) {
      const parts = albumName.split('|').map((s) => s.trim());
      artistName = parts[0]!;
      albumName = parts[1]!;
    }

    const albumInfo = await this.albumService.getAlbumInfo(artistName, albumName, user.userNameLastFm);
    const resolvedArtist = albumInfo?.artistName ?? artistName;
    const resolvedAlbum = albumInfo?.name ?? albumName;

    const friendUsers = await this.whoKnowsAlbumService.getFriendUsersForAlbum(
      context.guild,
      user.userId,
      resolvedArtist,
      resolvedAlbum,
    );

    const requesterMember = context.guild?.members.cache.get(user.discordUserId);
    const usersWithCaller = WhoKnowsService.addOrReplaceUserToIndexList(
      friendUsers,
      user,
      requesterMember?.displayName,
      albumInfo?.userPlayCount,
    );

    const [imgUrl, closeFriends] = await Promise.all([
      this.artworkService.getAlbumCoverUrl(resolvedAlbum, resolvedArtist),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `Friends who know ${resolvedAlbum} by ${resolvedArtist}`;
    const url = lastfmAlbumUrl(resolvedArtist, resolvedAlbum);
    const footerExtra = `Friends who know for ${context.member?.displayName ?? user.userNameLastFm}`;

    return WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      usersWithCaller,
      undefined,
      undefined,
      undefined,
      closeFriends,
      mode,
      footerExtra,
    );
  }
}
