import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { RecentBuilders } from '@bot/builders/recentBuilders';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { CommandResponse } from '@domain/enums/commandResponse';
import { container } from 'tsyringe';
import { FmSettingService } from '@bot/services/system/fmSettingService';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { ChannelRepository } from '@persistence/repositories/channelRepository';
import { parseFmEmbedType } from '@domain/enums/fmEmbedType';
import { PrefixService } from '@bot/services/prefixService';
import { ArtworkService, isPlaceholderImageUrl } from '@bot/services/artworkService';
import { FmFooterResolver } from '@bot/services/system/fmFooterResolver';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import { ColorService } from '@bot/services/system/colorService';
import { ExposedService } from '@bot/services/exposedService';
import type { RecentTrack } from '@domain/models/recentTrack';

async function enrichFmTracks(tracks: RecentTrack[]): Promise<void> {
  if (!tracks[0]) return;
  const lfmImage = tracks[0].imageUrl;
  const isPlaceholder = !lfmImage || isPlaceholderImageUrl(lfmImage);
  try {
    const artService = container.resolve(ArtworkService);
    let resolved: string | null = null;
    if (tracks[0].albumName) resolved = await artService.getAlbumCoverUrl(tracks[0].albumName, tracks[0].artistName);
    if (!resolved) resolved = await artService.getTrackCoverUrl(tracks[0].name, tracks[0].artistName);
    if (resolved) tracks[0].imageUrl = resolved;
    else if (isPlaceholder) tracks[0].imageUrl = undefined;
  } catch {
    if (isPlaceholder) tracks[0].imageUrl = undefined;
  }
}

const cooldownMap = new Map<string, number>();
const COOLDOWN_MS = 3000;

export class PlayCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly userService: UserService;
  private readonly lastfmRepository: ILastfmRepository;
  private readonly updateService: UpdateService;

  constructor(
    userService: UserService,
    lastfmRepository: ILastfmRepository,
    updateService: UpdateService,
  ) {
    this.userService = userService;
    this.lastfmRepository = lastfmRepository;
    this.updateService = updateService;
    this.commands = [
      {
        name: 'fm',
        aliases: ['np','qm','wm','em','rm','tm','ym','om','pm','gm','sm','hm','jm','km','lm','zm','xm','cm','vm','bm','nm','mm','nowplaying','ɯɟ'],
        executeAsync: (context, args) => this.fmAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'recent',
        aliases: ['r', 'recents', 'recenttracks', 'rp', 'history'],
        executeAsync: (context, args) => this.recentAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'register',
        executeAsync: (context, args) => this.registerAsync(context, args),
      },
      {
        name: 'fmmode',
        aliases: ['fmsettings'],
        executeAsync: (context) => this.fmModeAsync(context),
      },
    ];
  }

  /**
   * The `.fm` cooldown is a guard on the Last.fm quota, so it is claimed at the
   * last moment before a Last.fm read and NOWHERE else. A request that asks
   * Last.fm nothing — `.fm help`, an account-less caller, an unregistered
   * mention — must neither spend a token nor be refused by one; being told to
   * wait costs the user three seconds and protects nothing.
   *
   * Called from the two read sites, so each one spends at most one token.
   */
  private claimCooldownSlot(context: ContextModel, channelId: string | undefined): ResponseModel | null {
    if (!context.guildId || !channelId) return null;
    const key = `${channelId}:${context.discordUserId}`;
    const waited = Date.now() - (cooldownMap.get(key) ?? 0);
    if (waited < COOLDOWN_MS) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Cooldown,
        `You're on cooldown. Try again in ${Math.ceil((COOLDOWN_MS - waited) / 1000)}s.`,
      );
    }
    cooldownMap.set(key, Date.now());
    return null;
  }

  private async fmAsync(context: ContextModel, options: string): Promise<ResponseModel> {
    const channelId = context.interaction?.channelId ?? context.message?.channelId ?? undefined;

    // Ahead of the cooldown, deliberately. The cooldown guards the Last.fm
    // quota and this branch asks Last.fm nothing — it is a read of static text
    // plus a cached prefix. A user asking how the command works must never be
    // charged for it, and must never be told to wait for the answer.
    if (options?.trim().toLowerCase() === 'help') {
      const prefix = context.guildId ? await container.resolve(PrefixService).getPrefix(context.guildId) : '!';
      return GenericEmbedService.buildNotFoundResponse(`**${prefix}fm** — shows your current track.\nUsage: \`${prefix}fm [@user|lfm:username] [tiny|full|mini|textfull|oneline]\``);
    }

    // parse target + inline embed type
    let targetUserName: string | null = null;
    // The layout token is the TAIL of the argument list — the same shape `lfm:`
    // is read with below. `parseFmEmbedType` matches BARE tokens only, so it
    // used to be handed the WHOLE argument string and could never see a token
    // that followed a mention or a name: `.fm <@123> mini` parsed to `null` and
    // the request was silently neither applied nor stripped, so the caller got
    // the default embed after asking for another one. The slash twin reads a
    // typed Discord option and never had this shape.
    const trimmedOptions = options.trim();
    const tailToken = trimmedOptions.split(/\s+/).pop() ?? '';
    const inlineEmbedType = parseFmEmbedType(tailToken);
    // Sliced by LENGTH, not replaced. The token is the tail, so its length is
    // exactly how many characters to drop whatever their case, and a
    // `replace(/mini/i, '')` — the shape this replaced — would eat a real
    // argument: `mini` and `minidisco` are both valid Last.fm usernames, and
    // stripping either leaves an empty target that quietly searches the
    // caller's own account instead.
    const cleanOptions = inlineEmbedType === null
      ? trimmedOptions
      : trimmedOptions.slice(0, trimmedOptions.length - tailToken.length).trim();
    // mention <@123> or <@!123>
    const mentionMatch = cleanOptions.match(/<@!?(\d+)>/);
    const targetUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!targetUser) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use the register command first.');
    }
    let displayUser = targetUser;
    let differentUser = false;
    if (mentionMatch) {
      const mentioned = await this.userService.getUserByDiscordId(mentionMatch[1]!);
      if (!mentioned) {
        return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, `<@${mentionMatch[1]}> hasn't connected their Last.fm account yet. They need to use \`${context.prefix}register <username>\` first.`);
      }
      displayUser = mentioned; differentUser = true;
    } else if (cleanOptions.toLowerCase().startsWith('lfm:')) {
      targetUserName = cleanOptions.slice(4).trim().split(/\s+/)[0] ?? null;
      if (targetUserName) {
        const refused = this.claimCooldownSlot(context, channelId);
        if (refused) return refused;
        // fetch as external lfm user (no DB)
        const [tracks, info] = await Promise.all([
          this.lastfmRepository.getUserRecentTracks(targetUserName, 5),
          this.lastfmRepository.getUserInfo(targetUserName),
        ]);
        if (!info && (!tracks || tracks.length === 0)) {
          return GenericEmbedService.buildNotFoundResponse(`Could not find a Last.fm user named **${targetUserName}**.`);
        }
        await enrichFmTracks(tracks);
        // build as if external
        const fakeUser = { ...targetUser, userNameLastFm: targetUserName } as typeof targetUser;
        const colorService = container.resolve(ColorService);
        const accentColor = await colorService.getColorFromImageUrl(tracks[0]?.imageUrl);
        return PlayBuilders.buildFmResponse(context, fakeUser, tracks, info, { guildFmType: null, channelFmType: null, inlineEmbedType, differentUser: true, accentColor });
      }
    }

    // Every path that reaches here makes a Last.fm read below, so this is the
    // one place the common case is charged — after the two refusals above,
    // neither of which asked Last.fm anything.
    const refused = this.claimCooldownSlot(context, channelId);
    if (refused) return refused;

    // fetch fm setting for display user
    let fmSetting: { embedType: number; footerOptions: bigint; smallTextType: number | null; buttons: bigint } | null = null;
    let guildFmType: number | null | undefined = null;
    let channelFmType: number | null | undefined = null;
    // CORRECT AS IS, and it is the same three PRESENTATION reads the slash twin
    // `userSlashCommands.fmAsync` documents: `fmSetting` falls back to null (the
    // bot's default embed type), `guildFmType` and `channelFmType` fall back to
    // null ("no override", which is what an unconfigured server should render). A
    // database outage costs the guild's chosen embed STYLE, not a single
    // playcount - the `.fm` numbers come from the two Last.fm reads below, which
    // are outside this try.
    try {
      const fmService = container.resolve(FmSettingService);
      fmSetting = await fmService.get(displayUser.userId);
      if (context.guildId) {
        const guildRepo = container.resolve(GuildRepository);
        const guild = await guildRepo.getGuild(context.guildId);
        guildFmType = guild?.fmEmbedType ?? null;
      }
      if (channelId) {
        const channelRepo = container.resolve(ChannelRepository);
        const ch = await channelRepo.getChannel(channelId);
        channelFmType = ch?.fmEmbedType ?? null;
      }
    } catch { /* ignore */ }

    // A now-playing response must not wait for a multi-page database sync. Fetch the
    // two records needed to render it immediately and refresh local stats in the background.
    let tracks: Awaited<ReturnType<ILastfmRepository['getUserRecentTracks']>> = [];
    let lastfmUser: Awaited<ReturnType<ILastfmRepository['getUserInfo']>> = null;
    if (!differentUser) {
      const shouldDelta = UpdateService.needsUpdate(displayUser, 2); // 2 min — fmbot is effectively always but we throttle
      if (shouldDelta) {
        void this.updateService.updateUser(displayUser.userId, { accurateTotal: true });
      }
      [tracks, lastfmUser] = await Promise.all([
        this.lastfmRepository.getUserRecentTracks(displayUser.userNameLastFm, 2, 1, undefined, displayUser.sessionKey),
        this.lastfmRepository.getUserInfo(displayUser.userNameLastFm),
      ]);
    } else {
      [tracks, lastfmUser] = await Promise.all([
        this.lastfmRepository.getUserRecentTracks(displayUser.userNameLastFm, 2),
        this.lastfmRepository.getUserInfo(displayUser.userNameLastFm),
      ]);
    }

    await enrichFmTracks(tracks);

    const colorService = container.resolve(ColorService);
    const accentColor = await colorService.getColorFromImageUrl(tracks[0]?.imageUrl);

    const footerOptions = fmSetting ? BigInt(fmSetting.footerOptions) : BigInt(FmFooterOption.TotalScrobbles);
    const footerData = tracks[0]
      ? await FmFooterResolver.resolveFooterData(displayUser, tracks[0], footerOptions, context.guildId)
      : {};

    const response = PlayBuilders.buildFmResponse(context, displayUser, tracks, lastfmUser, {
      fmSetting,
      guildFmType: guildFmType ?? null,
      channelFmType: channelFmType ?? null,
      inlineEmbedType: inlineEmbedType ?? null,
      differentUser,
      accentColor,
      ...footerData,
    });

    // Check for rare live 4K anomaly (subject to 24h guild / 7d user cooldown)
    if (context.guildId && tracks[0] && container.isRegistered(ExposedService)) {
      try {
        const anomaly = await container.resolve(ExposedService).checkLiveNowPlayingAnomaly(
          displayUser,
          context.guildId,
          tracks[0].artistName,
          tracks[0].name,
        );
        if (anomaly) {
          response.content = `📸 **CAUGHT IN 4K:** <@${displayUser.discordUserId}> — *${anomaly.roast}* \`[Guilty tag: ${anomaly.matchedGenre}]\``;
        }
      } catch {
        // CORRECT AS IS: a NOSTALGIA FEATURE. `checkLiveNowPlayingAnomaly` looks
        // for a coincidence between a now-playing track and an already-posted
        // "CAUGHT IN 4K" roast, and its only product is `response.content` -
        // the joke line. A failure omits a joke; it cannot change the embed, whose
        // tracks, scrobble count and footer were built above from the Last.fm
        // reads. The safe failover is named because the alternative would be to
        // fail an entire `.fm` over a gag.
        // Safe failover
      }
    }

    return response;
  }

  private async registerAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const username = args[0]?.trim();
    if (!username || username.length > 255) {
      return GenericEmbedService.buildWrongInputResponse(
        'Please provide a valid Last.fm username.',
      );
    }

    const lastfmUser = await this.lastfmRepository.getUserInfo(username);
    if (!lastfmUser) {
      return GenericEmbedService.buildNotFoundResponse(
        `Could not find a Last.fm user named **${username}**.`,
      );
    }

    await this.userService.setUserLastFm(context.discordUserId, username);
    return PlayBuilders.buildRegisterSuccessResponse(username, context.accentColor);
  }

  private async fmModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Connect your Last.fm account first with \`${context.prefix}register <username>\`.`,
      );
    }
    const setting = await container.resolve(FmSettingService).getOrCreate(user.userId);
    return PlayBuilders.buildFmModeResponse(setting, context.accentColor);
  }

  private async recentAsync(context: ContextModel, argsStr: string): Promise<ResponseModel> {
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    let targetDiscordId = context.discordUserId;
    let targetUserName = caller.userNameLastFm;
    let targetDisplayName = context.message?.member?.displayName ?? caller.userNameLastFm;
    let targetSessionKey: string | undefined = caller.sessionKey;
    let page = 1;

    if (argsStr.trim()) {
      const arg = argsStr.trim();
      const mentionMatch = arg.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        targetDiscordId = mentionMatch[1]!;
        const other = await this.userService.getUserByDiscordId(targetDiscordId);
        if (other) {
          targetUserName = other.userNameLastFm;
          targetDisplayName = context.message?.guild?.members.cache.get(targetDiscordId)?.displayName ?? other.userNameLastFm;
          targetSessionKey = other.sessionKey;
          if (UpdateService.needsUpdate(other, 2)) {
            void this.updateService.updateUser(other.userId, { accurateTotal: true });
          }
        }
      } else if (arg.toLowerCase().startsWith('lfm:')) {
        targetUserName = arg.slice(4).trim();
        targetDisplayName = targetUserName;
        targetSessionKey = undefined;
      } else if (/^\d+$/.test(arg)) {
        page = Math.min(80, Math.max(1, parseInt(arg, 10)));
      } else {
        const other = await this.userService.getUserByLastFmName(arg);
        if (other) {
          targetDiscordId = other.discordUserId;
          targetUserName = other.userNameLastFm;
          targetDisplayName = context.message?.guild?.members.cache.get(other.discordUserId)?.displayName ?? other.userNameLastFm;
          targetSessionKey = other.sessionKey;
          if (UpdateService.needsUpdate(other, 2)) {
            void this.updateService.updateUser(other.userId, { accurateTotal: true });
          }
        } else {
          targetUserName = arg;
          targetDisplayName = arg;
          targetSessionKey = undefined;
        }
      }
    }

    const recentData = await this.lastfmRepository.getUserRecentTracksWithMetadata(
      targetUserName,
      6,
      page,
      undefined,
      targetSessionKey,
    );
    if (!recentData || recentData.tracks.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(`No scrobbles found for ${targetDisplayName}.`);
    }

    await enrichFmTracks(recentData.tracks);
    const colorService = container.resolve(ColorService);
    const accentColor = await colorService.getColorFromImageUrl(recentData.tracks[0]?.imageUrl);

    return RecentBuilders.buildRecentTracksResponse(
      targetUserName,
      targetDisplayName,
      targetDiscordId,
      recentData,
      page,
      accentColor,
    );
  }
}
