import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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
import { FmEmbedType } from '@domain/enums/fmEmbedType';
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

export class UserSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

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
        data: new SlashCommandBuilder()
          .setName('fm')
          .setDescription('Shows what you are listening to')
          .addUserOption(o => o.setName('user').setDescription('Discord user to show').setRequired(false))
          .addStringOption(o => o.setName('lfm').setDescription('Last.fm username (or lfm:username)').setRequired(false))
          .addStringOption(o => o.setName('embed-type').setDescription('Embed style override').setRequired(false).addChoices(
            { name: 'Embed Mini', value: String(FmEmbedType.EmbedMini) },
            { name: 'Embed Full', value: String(FmEmbedType.EmbedFull) },
            { name: 'Embed Tiny', value: String(FmEmbedType.EmbedTiny) },
            { name: 'Text Full', value: String(FmEmbedType.TextFull) },
            { name: 'Text Mini', value: String(FmEmbedType.TextMini) },
            { name: 'Text One Line', value: String(FmEmbedType.TextOneLine) },
          ))
          .addIntegerOption(o => o.setName('page').setDescription('Page number of recent tracks (optional)').setRequired(false)),
        executeAsync: (context) => {
          if (context.interaction?.options.getInteger('page')) {
            return this.recentAsync(context);
          }
          return this.fmAsync(context);
        },
      },
      {
        data: new SlashCommandBuilder().setName('fmmode').setDescription('Customize your .fm appearance'),
        executeAsync: (context) => this.fmModeAsync(context),
      },
      {
        data: new SlashCommandBuilder()
          .setName('register')
          .setDescription('Connect your Last.fm account')
          .addStringOption((option) =>
            option.setName('username').setDescription('Your Last.fm username').setRequired(true),
          ),
        executeAsync: (context) => this.registerAsync(context),
      },
    ];
  }

  private async fmAsync(context: ContextModel): Promise<ResponseModel> {
    const discordTarget = context.interaction?.options.getUser('user') ?? null;
    const rawLfm = context.interaction?.options.getString('lfm')?.trim() ?? null;
    // backward-compat: if old "user" string slot was used via raw string, discord.js will not return it as User;
    // we keep a fallback parse from the raw lfm field which may contain "lfm:xxx" or plain username
    const legacyRawUser = (() => {
      try { return context.interaction?.options.getString('user')?.trim() ?? null; } catch { return null; }
    })();
    const rawEmbed = context.interaction?.options.getString('embed-type') ?? null;
    const inlineEmbedType = rawEmbed !== null ? (Number(rawEmbed) as FmEmbedType) : null;

    const targetUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!targetUser) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use `/register` first.');
    }
    let displayUser = targetUser;
    let differentUser = false;

    // 1) Discord user picker takes priority
    if (discordTarget) {
      const m = await this.userService.getUserByDiscordId(discordTarget.id);
      if (!m) {
        return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, `<@${discordTarget.id}> hasn't connected their Last.fm account yet. They need to use \`/register <username>\` first.`);
      }
      displayUser = m;
      differentUser = true;
    } else if (rawLfm) {
      // 2) Explicit lfm: string option
      let lfm = rawLfm;
      if (lfm.toLowerCase().startsWith('lfm:')) lfm = lfm.slice(4).trim();
      if (lfm) {
        const [tracks, info] = await Promise.all([this.lastfmRepository.getUserRecentTracks(lfm, 5), this.lastfmRepository.getUserInfo(lfm)]);
        if (!info && (!tracks || tracks.length === 0)) {
          return GenericEmbedService.buildNotFoundResponse(`Could not find a Last.fm user named **${lfm}**.`);
        }
        await enrichFmTracks(tracks);
        const fake = { ...targetUser, userNameLastFm: lfm } as typeof targetUser;
        return PlayBuilders.buildFmResponse(context, fake, tracks, info, { inlineEmbedType });
      }
    } else if (legacyRawUser) {
      // 3) Legacy fallback: raw string that looked like <@id> or lfm:xxx passed to old string slot
      const mentionMatch = legacyRawUser.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const m = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!m) {
          return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, `<@${mentionMatch[1]}> hasn't connected their Last.fm account yet.`);
        }
        displayUser = m; differentUser = true;
      } else if (legacyRawUser.toLowerCase().startsWith('lfm:')) {
        const lfm = legacyRawUser.slice(4).trim();
        if (lfm) {
          const [tracks, info] = await Promise.all([this.lastfmRepository.getUserRecentTracks(lfm, 5), this.lastfmRepository.getUserInfo(lfm)]);
          if (!info && (!tracks || tracks.length === 0)) {
            return GenericEmbedService.buildNotFoundResponse(`Could not find a Last.fm user named **${lfm}**.`);
          }
          await enrichFmTracks(tracks);
          const fake = { ...targetUser, userNameLastFm: lfm } as typeof targetUser;
          return PlayBuilders.buildFmResponse(context, fake, tracks, info, { inlineEmbedType });
        }
      } else {
        const maybe = await this.userService.getUserByDiscordId(legacyRawUser);
        if (maybe) { displayUser = maybe; differentUser = true; }
        else if (legacyRawUser) {
          // treat as bare last.fm username
          const lfm = legacyRawUser.trim();
          const [tracks, info] = await Promise.all([this.lastfmRepository.getUserRecentTracks(lfm, 5), this.lastfmRepository.getUserInfo(lfm)]);
          if (info || (tracks && tracks.length > 0)) {
            await enrichFmTracks(tracks);
            const fake = { ...targetUser, userNameLastFm: lfm } as typeof targetUser;
            return PlayBuilders.buildFmResponse(context, fake, tracks, info, { inlineEmbedType });
          }
        }
      }
    }

    let fmSetting: { embedType: number; footerOptions: bigint; smallTextType: number | null; accentColor: number | null; customColor: string | null; buttons: bigint } | null = null;
    let guildFmType: number | null = null;
    let channelFmType: number | null = null;
    const slashChannelId = context.interaction?.channelId ?? context.message?.channelId ?? null;
    try {
      const fmService = container.resolve(FmSettingService);
      fmSetting = await fmService.get(displayUser.userId) as unknown as typeof fmSetting;
      if (context.guildId) {
        const g = await container.resolve(GuildRepository).getGuild(context.guildId);
        guildFmType = (g as unknown as { fmEmbedType?: number | null })?.fmEmbedType ?? null;
      }
      if (slashChannelId) {
        const ch = await container.resolve(ChannelRepository).getChannel(slashChannelId);
        channelFmType = (ch as unknown as { fmEmbedType?: number | null })?.fmEmbedType ?? null;
      }
    } catch { /* */ }

    let tracks: Awaited<ReturnType<ILastfmRepository['getUserRecentTracks']>> = [];
    let lastfmUser: Awaited<ReturnType<ILastfmRepository['getUserInfo']>> = null;
    if (!differentUser) {
      const shouldDelta = UpdateService.needsUpdate(displayUser, 2);
      if (shouldDelta) {
        // Never make the interaction wait for the multi-page history sync.
        void this.updateService.updateUser(displayUser.userId, { accurateTotal: true });
      }
      [tracks, lastfmUser] = await Promise.all([this.lastfmRepository.getUserRecentTracks(displayUser.userNameLastFm, 2, 1, undefined, displayUser.sessionKey), this.lastfmRepository.getUserInfo(displayUser.userNameLastFm)]);
    } else {
      [tracks, lastfmUser] = await Promise.all([this.lastfmRepository.getUserRecentTracks(displayUser.userNameLastFm, 2), this.lastfmRepository.getUserInfo(displayUser.userNameLastFm)]);
    }
    await enrichFmTracks(tracks);
    return PlayBuilders.buildFmResponse(context, displayUser, tracks, lastfmUser, { fmSetting: fmSetting as unknown as { embedType: number; footerOptions: bigint; smallTextType: number | null; accentColor: number | null; customColor: string | null; buttons: bigint } | null, guildFmType, channelFmType, inlineEmbedType, differentUser });
  }

  private async fmModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'Connect with `/register` first.');
    const fmService = container.resolve(FmSettingService);
    const setting = await fmService.getOrCreate(user.userId);
    const embed = PlayBuilders.buildFmModeResponse(setting, context.accentColor);
    return embed;
  }

  private async registerAsync(context: ContextModel): Promise<ResponseModel> {
    const username = context.interaction?.options.getString('username')?.trim();
    if (!username || username.length > 255) {
      return GenericEmbedService.buildWrongInputResponse('Please provide a valid Last.fm username.');
    }

    const lastfmUser = await this.lastfmRepository.getUserInfo(username);
    if (!lastfmUser) {
      return GenericEmbedService.buildNotFoundResponse(
        `Could not find a Last.fm user named **${username}**.`,
      );
    }

    const user = await this.userService.setUserLastFm(context.discordUserId, username);
    void user;

    return PlayBuilders.buildRegisterSuccessResponse(username, context.accentColor);
  }

  private async recentAsync(context: ContextModel): Promise<ResponseModel> {
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    const targetUserOpt = context.interaction?.options.getUser('user');
    const targetUsernameOpt = context.interaction?.options.getString('username')?.trim();
    const page = Math.min(80, Math.max(1, context.interaction?.options.getInteger('page') ?? 1));

    let targetDiscordId = context.discordUserId;
    let targetUserName = caller.userNameLastFm;
    let targetDisplayName = context.member?.displayName ?? caller.userNameLastFm;
    let targetSessionKey: string | undefined = caller.sessionKey;

    if (targetUserOpt) {
      targetDiscordId = targetUserOpt.id;
      const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!targetUser) {
        return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
      }
      targetUserName = targetUser.userNameLastFm;
      targetDisplayName = context.guild?.members.cache.get(targetDiscordId)?.displayName ?? targetUserOpt.username;
      targetSessionKey = targetUser.sessionKey;
      if (UpdateService.needsUpdate(targetUser, 2)) {
        void this.updateService.updateUser(targetUser.userId, { accurateTotal: true });
      }
    } else if (targetUsernameOpt) {
      const other = await this.userService.getUserByLastFmName(targetUsernameOpt);
      if (other) {
        targetDiscordId = other.discordUserId;
        targetUserName = other.userNameLastFm;
        targetDisplayName = context.guild?.members.cache.get(other.discordUserId)?.displayName ?? other.userNameLastFm;
        targetSessionKey = other.sessionKey;
        if (UpdateService.needsUpdate(other, 2)) {
          void this.updateService.updateUser(other.userId, { accurateTotal: true });
        }
      } else {
        targetUserName = targetUsernameOpt;
        targetDisplayName = targetUsernameOpt;
        targetSessionKey = undefined;
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
