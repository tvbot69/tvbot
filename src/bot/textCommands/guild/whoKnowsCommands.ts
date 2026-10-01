import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { UserService } from '@bot/services/user/userService';
import { SettingService } from '@bot/services/system/settingService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { ArtistsService } from '@bot/services/library/artistsService';
import { AlbumService } from '@bot/services/library/albumService';
import { TrackService } from '@bot/services/library/trackService';
import { FriendsService } from '@bot/services/social/friendsService';
import { WhoKnowsArtistService } from '@bot/services/whoKnows/whoKnowsArtistService';
import { WhoKnowsTrackService } from '@bot/services/whoKnows/whoKnowsTrackService';
import { WhoKnowsAlbumService } from '@bot/services/whoKnows/whoKnowsAlbumService';
import { WhoKnowsPlayService } from '@bot/services/whoKnows/whoKnowsPlayService';
import { WhoKnowsBuilders } from '@bot/builders/whoknows/whoKnowsBuilders';
import { WhoKnowsService } from '@bot/services/whoKnows/whoKnowsService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { container } from 'tsyringe';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { GenreService } from '@bot/services/library/genreService';

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

    const defaultMode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const settings = this.settingService.setWhoKnowsSettings(rawArgs, defaultMode);
    return this.buildWhoKnowsArtist(context, user, settings.newSearchValue, {
      responseMode: settings.responseMode,
      qualityFilterDisabled: settings.qualityFilterDisabled,
    });
  }

  /**
   * Typed entry point for callers that already know exactly which artist they
   * mean and have no free text to parse.
   *
   * This exists because the crown button used to call whoKnowsArtistAsync
   * directly, which runs the value through setWhoKnowsSettings — a TEXT
   * grammar that strips `img|image`, `embed|text|txt`, `pages|page|p|pp`,
   * `nf|nofilter` and `nr|noredirect` from the search value. A band whose
   * name is one of those words ("Page", "Text", "Image", "Nf") therefore came
   * out of a crown button as a mangled, different artist. The button now calls
   * this method and the artist name is used verbatim.
   */
  public async whoKnowsArtistForName(context: ContextModel, artistName: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }
    this.checkSync(user);
    const mode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    return this.buildWhoKnowsArtist(context, user, artistName, {
      responseMode: mode,
      qualityFilterDisabled: false,
    });
  }

  /** Shared body: resolve the artist, then build the guild leaderboard. */
  private async buildWhoKnowsArtist(
    context: ContextModel,
    user: User,
    searchValue: string,
    opts: { responseMode: WhoKnowsMode; qualityFilterDisabled: boolean },
  ): Promise<ResponseModel> {
    // Both entry points guard, but the shared body must be safe on its own.
    if (!context.guild) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    let artistName = searchValue;
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

    // Disambiguate same-name artists ("Mond" the Egyptian rapper vs "Mond" the
    // metal band) by anchoring artwork/genre lookups to a real scrobble.
    const artistTrackService = container.resolve(ArtistTrackService);
    // CORRECT AS IS, and the slash twin carries the same comment with the same
    // reasoning. `getSampleTrackForArtist` is a PRECISION ANCHOR for external
    // metadata - it disambiguates "Mond" the rapper from "Mond" the metal band by
    // pinning the exact entity via a real scrobble - and never a number the user
    // reads. The playcounts come from `whoKnowsArtistService` below. The method's
    // own doc records that it already returns `undefined` rather than rejecting
    // when a lookup fails, so this `.catch` is belt-and-braces and the worst case
    // is name-only artwork and genre resolution.
    const callerSampleTrack = await artistTrackService
      .getSampleTrackForArtist(user.userId, resolvedName)
      .catch(() => undefined);

    const result = await this.whoKnowsArtistService.getFilteredUsersForArtist(
      context.guild,
      user,
      resolvedName,
      livePlaycount,
      opts.qualityFilterDisabled,
      callerSampleTrack,
    );

    // Caller doesn't know the artist but someone in the guild does — anchor on
    // the top listener's scrobble instead so image/genres still resolve correctly.
    let sampleTrack = callerSampleTrack;
    let anchoredGenres: string[] | undefined;
    const topListenerId = result.filteredUsersWithArtist[0]?.userId;
    if (!sampleTrack && topListenerId !== undefined) {
      // CORRECT AS IS, second anchor site and the same reasoning as the one
      // above: the retry against the top listener's own scrobble is a refinement
      // for artwork and genres, and failing it leaves the leaderboard - every
      // listener, every playcount, the rank order - exactly as it would render
      // with no sample track at all.
      sampleTrack = await artistTrackService
        .getSampleTrackForArtist(topListenerId, resolvedName)
        .catch(() => undefined);
      if (sampleTrack) {
        // CORRECT AS IS. Same reasoning, same trade, and the same reason it is
        // not the `.affinity` partial-success shape: `anchoredGenres` stays
        // `undefined` on failure so the `!== undefined` guard below skips the
        // assignment and the card keeps the genres the service already had. A
        // genuine empty (`[]`) overwrites, so a real "no genres" and a failed
        // read never collapse into the same value. The user sees the card minus
        // one decoration; raising would delete a real leaderboard over a
        // footer line that has no "could not load" affordance to render into.
        anchoredGenres = await container
          .resolve(GenreService)
          .getGenresForArtist(resolvedName, sampleTrack)
          .catch(() => undefined);
      }
    }
    if (anchoredGenres !== undefined) {
      result.genres = anchoredGenres;
    }

    const [imgUrl, alsoPlaying, closeFriends] = await Promise.all([
      this.artworkService.getArtistImageUrl(resolvedName, sampleTrack),
      this.whoKnowsPlayService.getGuildAlsoPlayingArtist(user.userId, result.guildUsers, resolvedName),
      this.friendsService.getCloseFriendUserIds(user.userId),
    ]);

    const title = `${resolvedName} in ${context.guild.name}`;
    const url = lastfmArtistUrl(resolvedName);
    const accentColor = await this.artistsService.getArtistAccentColorAsync(imgUrl);

    const crownMessage =
      (result.crownModel?.claimed || result.crownModel?.stolen)
        ? (result.crownModel.crownResult ?? undefined)
        : undefined;

    const globalStats = {
      globalPlays: artistInfo?.playCount,
      globalListeners: artistInfo?.listeners,
    };

    return await WhoKnowsBuilders.buildWhoKnowsResponse(
      context,
      title,
      url,
      imgUrl,
      result.filteredUsersWithArtist,
      result.filterStats,
      alsoPlaying,
      result.genres,
      closeFriends,
      opts.responseMode,
      crownMessage,
      'Artist',
      accentColor,
      globalStats,
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

    const defaultMode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const settings = this.settingService.setWhoKnowsSettings(rawArgs, defaultMode);
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
    const accentColor = await this.albumService.getAlbumAccentColor(imgUrl);

    const globalStats = {
      globalPlays: trackInfo?.playCount,
      globalListeners: trackInfo?.listeners,
      topItemLabel: 'Album',
      topItemValue: trackInfo?.albumName,
    };

    return await WhoKnowsBuilders.buildWhoKnowsResponse(
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
      undefined,
      'Track',
      accentColor,
      globalStats,
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

    const defaultMode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const settings = this.settingService.setWhoKnowsSettings(rawArgs, defaultMode);
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
    const albumAccentColor = await this.albumService.getAlbumAccentColor(imgUrl);

    const albumTracksFromInfo = albumInfo?.tracks?.slice(0, 3).map((t) => t.name).filter(Boolean);
    const albumGlobalStats = {
      globalPlays: albumInfo?.playCount,
      globalListeners: albumInfo?.listeners,
      topItemLabel: 'Top Track',
      topItemValue: albumInfo?.tracks?.[0]?.name,
      topItemExtra: albumInfo?.tracks?.length ? `${albumInfo.tracks.length} tracks` : undefined,
      topTracks: albumTracksFromInfo && albumTracksFromInfo.length > 0 ? albumTracksFromInfo : undefined,
    };

    return await WhoKnowsBuilders.buildWhoKnowsResponse(
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
      undefined,
      'Album',
      albumAccentColor,
      albumGlobalStats,
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

    const defaultMode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const settings = this.settingService.setWhoKnowsSettings(rawArgs, defaultMode);
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
    const accentColor = await this.artistsService.getArtistAccentColorAsync(imgUrl);

    return await WhoKnowsBuilders.buildWhoKnowsResponse(
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
      'Artist',
      accentColor,
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

    const defaultMode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const settings = this.settingService.setWhoKnowsSettings(rawArgs, defaultMode);
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
    const accentColor = await this.albumService.getAlbumAccentColor(imgUrl);

    return await WhoKnowsBuilders.buildWhoKnowsResponse(
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
      'Track',
      accentColor,
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

    const defaultMode = (user.whoKnowsMode as WhoKnowsMode) ?? WhoKnowsMode.Default;
    const settings = this.settingService.setWhoKnowsSettings(rawArgs, defaultMode);
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
    const accentColor = await this.albumService.getAlbumAccentColor(imgUrl);

    return await WhoKnowsBuilders.buildWhoKnowsResponse(
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
      'Album',
      accentColor,
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
