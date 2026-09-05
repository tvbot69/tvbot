import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { RecentBuilders } from '@bot/builders/recentBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { UpdateService } from '@bot/services/updateService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { CommandResponse } from '@domain/enums/commandResponse';
import { container } from 'tsyringe';
import { FmSettingService } from '@bot/services/fmSettingService';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { ChannelRepository } from '@persistence/repositories/channelRepository';
import { parseFmEmbedType } from '@domain/enums/fmEmbedType';
import { PrefixService } from '@bot/services/prefixService';
import { ArtworkService } from '@bot/services/artworkService';
import type { RecentTrack } from '@domain/models/recentTrack';

const FM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';
async function enrichFmTracks(tracks: RecentTrack[]): Promise<void> {
  if (!tracks[0]) return;
  const lfmImage = tracks[0].imageUrl;
  const isPlaceholder = !lfmImage || lfmImage.includes(FM_PLACEHOLDER_HASH);
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

  private async fmAsync(context: ContextModel, options: string): Promise<ResponseModel> {
    const channelId = context.interaction?.channelId ?? context.message?.channelId ?? undefined;
    // cooldown per channel
    if (context.guildId && channelId) {
      const key = `${channelId}:${context.discordUserId}`;
      const last = cooldownMap.get(key) ?? 0;
      if (Date.now() - last < COOLDOWN_MS) {
        return GenericEmbedService.buildCommandErrorResponse(CommandResponse.Cooldown, `You're on cooldown. Try again in ${Math.ceil((COOLDOWN_MS - (Date.now() - last))/1000)}s.`);
      }
      cooldownMap.set(key, Date.now());
    }

    if (options?.trim().toLowerCase() === 'help') {
      const prefix = context.guildId ? await container.resolve(PrefixService).getPrefix(context.guildId) : '!';
      return GenericEmbedService.buildNotFoundResponse(`**${prefix}fm** — shows your current track.\nUsage: \`${prefix}fm [@user|lfm:username] [tiny|full|mini|textfull|oneline]\``);
    }

    // parse target + inline embed type
    let targetUserName: string | null = null;
    const inlineEmbedType = parseFmEmbedType(options);
    let cleanOptions = options;
    if (inlineEmbedType !== null) {
      // strip token
      const token = options.toLowerCase().split(/\s+/).find(s => parseFmEmbedType(s) !== null) ?? '';
      cleanOptions = options.replace(new RegExp(token, 'i'), '').trim();
    }
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
        return PlayBuilders.buildFmResponse(context, fakeUser, tracks, info, { guildFmType: null, channelFmType: null, inlineEmbedType, differentUser: true });
      }
    }

    // fetch fm setting for display user
    let fmSetting: { embedType: number; footerOptions: bigint; smallTextType: number | null; accentColor: number | null; customColor: string | null; buttons: bigint } | null = null;
    let guildFmType: number | null | undefined = null;
    let channelFmType: number | null | undefined = null;
    try {
      const fmService = container.resolve(FmSettingService);
      fmSetting = await fmService.get(displayUser.userId);
      if (context.guildId) {
        const guildRepo = container.resolve(GuildRepository);
        const guild = await guildRepo.getGuild(context.guildId);
        guildFmType = (guild as unknown as { fmEmbedType?: number | null })?.fmEmbedType ?? null;
      }
      if (channelId) {
        const channelRepo = container.resolve(ChannelRepository);
        const ch = await channelRepo.getChannel(channelId);
        channelFmType = (ch as unknown as { fmEmbedType?: number | null })?.fmEmbedType ?? null;
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

    return PlayBuilders.buildFmResponse(context, displayUser, tracks, lastfmUser, {
      fmSetting: fmSetting as unknown as { embedType: number; footerOptions: bigint; smallTextType: number | null; accentColor: number | null; customColor: string | null; buttons: bigint } | null,
      guildFmType: guildFmType ?? null,
      channelFmType: channelFmType ?? null,
      inlineEmbedType: inlineEmbedType ?? null,
      differentUser,
    });
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

    return RecentBuilders.buildRecentTracksResponse(
      targetUserName,
      targetDisplayName,
      targetDiscordId,
      recentData,
      page,
      context.accentColor,
    );
  }
}
