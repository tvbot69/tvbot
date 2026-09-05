import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
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

const lastfmArtistUrl = (artist: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;

const lastfmTrackUrl = (artist: string, track: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

const lastfmAlbumUrl = (artist: string, album: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;

export class WhoKnowsCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly userService: UserService;
  private readonly settingService: SettingService;
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
    settingService: SettingService,
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
    this.settingService = settingService;
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
        name: 'whoknows',
        aliases: ['wk', 'w', 'thosewhoknow'],
        executeAsync: (context, args) => this.whoKnowsArtistAsync(context, args.join(' ')),
      },
      {
        name: 'whoknowstrack',
        aliases: ['wkt', 'wt'],
        executeAsync: (context, args) => this.whoKnowsTrackAsync(context, args.join(' ')),
      },
      {
        name: 'whoknowsalbum',
        aliases: ['wka', 'wa'],
        executeAsync: (context, args) => this.whoKnowsAlbumAsync(context, args.join(' ')),
      },
      {
        name: 'friendwhoknows',
        aliases: ['fwk', 'fw', 'friendswhoknow'],
        executeAsync: (context, args) => this.friendsWhoKnowArtistAsync(context, args.join(' ')),
      },
      {
        name: 'friendwhoknowstrack',
        aliases: ['fwkt', 'fwt'],
        executeAsync: (context, args) => this.friendsWhoKnowTrackAsync(context, args.join(' ')),
      },
      {
        name: 'friendwhoknowsalbum',
        aliases: ['fwka', 'fwa'],
        executeAsync: (context, args) => this.friendsWhoKnowAlbumAsync(context, args.join(' ')),
      },
    ];
  }

  private checkSync(user: User): void {
    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }
  }

  public async whoKnowsArtistAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    this.checkSync(user);

    const settings = this.settingService.setWhoKnowsSettings(rawArgs);
    let artistName = settings.newSearchValue;
    let livePlaycount: number | undefined;

    if (!artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
    }

    // Get artist info / playcount for caller
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
      settings.qualityFilterDisabled,
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
      settings.responseMode,
      result.crownModel?.crownResult ?? undefined,
    );
  }

  private async whoKnowsTrackAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    this.checkSync(user);

    const settings = this.settingService.setWhoKnowsSettings(rawArgs);
    const query = settings.newSearchValue;
    let artistName = '';
    let trackName = '';
    let livePlaycount: number | undefined;

    if (!query) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
      trackName = recent[0]!.name;
    } else {
      const split = this.splitArtistTitle(query);
      if (split) {
        artistName = split.artist;
        trackName = split.title;
      } else {
        return GenericEmbedService.buildWrongInputResponse('Please specify a track in the format `Artist | Track` or `Track by Artist`.');
      }
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
      settings.qualityFilterDisabled,
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
      settings.responseMode,
    );
  }

  private async whoKnowsAlbumAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    this.checkSync(user);

    const settings = this.settingService.setWhoKnowsSettings(rawArgs);
    const query = settings.newSearchValue;
    let artistName = '';
    let albumName = '';
    let livePlaycount: number | undefined;

    if (!query) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      if (!recent[0]!.albumName) {
        return GenericEmbedService.buildNotFoundResponse('No album found on your current track.');
      }
      artistName = recent[0]!.artistName;
      albumName = recent[0]!.albumName;
    } else {
      const split = this.splitArtistTitle(query);
      if (split) {
        artistName = split.artist;
        albumName = split.title;
      } else {
        return GenericEmbedService.buildWrongInputResponse('Please specify an album in the format `Artist | Album` or `Album by Artist`.');
      }
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
      settings.qualityFilterDisabled,
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
      settings.responseMode,
    );
  }

  private async friendsWhoKnowArtistAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    this.checkSync(user);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    if (friends.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(
        `You have not added any friends yet. Add friends using \`${context.prefix}addfriend <username>\`.`,
      );
    }

    const settings = this.settingService.setWhoKnowsSettings(rawArgs);
    let artistName = settings.newSearchValue;

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
      settings.responseMode,
      footerExtra,
    );
  }

  private async friendsWhoKnowTrackAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    this.checkSync(user);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    if (friends.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(
        `You have not added any friends yet. Add friends using \`${context.prefix}addfriend <username>\`.`,
      );
    }

    const settings = this.settingService.setWhoKnowsSettings(rawArgs);
    const query = settings.newSearchValue;
    let artistName = '';
    let trackName = '';

    if (!query) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      artistName = recent[0]!.artistName;
      trackName = recent[0]!.name;
    } else {
      const split = this.splitArtistTitle(query);
      if (split) {
        artistName = split.artist;
        trackName = split.title;
      } else {
        return GenericEmbedService.buildWrongInputResponse('Please specify a track in the format `Artist | Track` or `Track by Artist`.');
      }
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
      settings.responseMode,
      footerExtra,
    );
  }

  private async friendsWhoKnowAlbumAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    this.checkSync(user);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    if (friends.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(
        `You have not added any friends yet. Add friends using \`${context.prefix}addfriend <username>\`.`,
      );
    }

    const settings = this.settingService.setWhoKnowsSettings(rawArgs);
    const query = settings.newSearchValue;
    let artistName = '';
    let albumName = '';

    if (!query) {
      const recent = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      }
      if (!recent[0]!.albumName) {
        return GenericEmbedService.buildNotFoundResponse('No album found on your current track.');
      }
      artistName = recent[0]!.artistName;
      albumName = recent[0]!.albumName;
    } else {
      const split = this.splitArtistTitle(query);
      if (split) {
        artistName = split.artist;
        albumName = split.title;
      } else {
        return GenericEmbedService.buildWrongInputResponse('Please specify an album in the format `Artist | Album` or `Album by Artist`.');
      }
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
      settings.responseMode,
      footerExtra,
    );
  }

  private splitArtistTitle(input: string): { artist: string; title: string } | null {
    if (input.includes('|')) {
      const parts = input.split('|').map((s) => s.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return { artist: parts[0], title: parts[1] };
      }
    }

    const byIndex = input.toLowerCase().indexOf(' by ');
    if (byIndex > 0) {
      const title = input.slice(0, byIndex).trim();
      const artist = input.slice(byIndex + 4).trim();
      if (title && artist) {
        return { artist, title };
      }
    }

    return null;
  }
}
