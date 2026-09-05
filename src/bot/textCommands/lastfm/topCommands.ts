import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { TopBuilders } from '@bot/builders/topBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateService } from '@bot/services/updateService';

import { ColorService } from '@bot/services/colorService';

export class TopCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];
  constructor(
    private readonly userService: UserService,
    private readonly settingService: SettingService,
    private readonly lastfmRepository: LastFmRepository,
    private readonly updateService: UpdateService,
    private readonly colorService?: ColorService,
  ) {
    this.commands = [
      { name: 'topartists', aliases: ['ta', 'al', 'as', 'artistlist', 'artists'], executeAsync: (ctx, args) => this.topArtistsAsync(ctx, args.join(' ')) },
      { name: 'topalbums', aliases: ['tab', 'talbum', 'topalbum', 'abl', 'abs', 'albumlist'], executeAsync: (ctx, args) => this.topAlbumsAsync(ctx, args.join(' ')) },
      { name: 'toptracks', aliases: ['tt', 'tl', 'tracklist', 'tracks'], executeAsync: (ctx, args) => this.topTracksAsync(ctx, args.join(' ')) },
    ];
  }

  private parseArgs(raw: string): { period: string; userStr: string | null } {
    let userStr: string | null = null;
    const tokens = raw.split(/\s+/).filter(Boolean);
    const mention = tokens.find(t => /^<@!?\d+>$/.test(t));
    if (mention) userStr = mention;
    else {
      const lfmIdx = tokens.findIndex(t => t.toLowerCase().startsWith('lfm:'));
      if (lfmIdx !== -1) userStr = tokens.slice(lfmIdx).join(' ');
    }
    if (!userStr) {
      const maybeUser = tokens.find(t => t.includes('@') || t.toLowerCase().startsWith('lfm:'));
      if (maybeUser) userStr = maybeUser;
    }
    let period = raw;
    if (userStr) period = period.replace(userStr, '').trim();
    if (!period) period = 'weekly';
    return { period, userStr };
  }

  private async resolveUser(context: ContextModel, rawUser: string | null): Promise<{ userNameLastFm: string; displayName: string; userId?: number; userObj?: any } | ResponseModel> {
    if (rawUser) {
      const mentionMatch = rawUser.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const u = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!u) return GenericEmbedService.buildNotFoundResponse(`<@${mentionMatch[1]}> is not registered.`);
        const member = context.guild?.members.cache.get(mentionMatch[1]!);
        return { userNameLastFm: u.userNameLastFm, displayName: member?.displayName ?? u.userNameLastFm, userId: u.userId, userObj: u };
      }
      if (rawUser.toLowerCase().startsWith('lfm:')) {
        const lfm = rawUser.slice(4).trim().split(/\s+/)[0]!;
        return { userNameLastFm: lfm, displayName: lfm };
      }
      const byLfm = await this.userService.getUserByLastFmName(rawUser.trim());
      if (byLfm) return { userNameLastFm: byLfm.userNameLastFm, displayName: rawUser.trim(), userId: byLfm.userId, userObj: byLfm };
    }
    const self = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!self) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use the register command first.');
    return { userNameLastFm: self.userNameLastFm, displayName: context.guild?.members.cache.get(context.discordUserId)?.displayName ?? self.userNameLastFm, userId: self.userId, userObj: self };
  }

  private async topArtistsAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const { period, userStr } = this.parseArgs(raw);
    const resolved = await this.resolveUser(context, userStr);
    if ((resolved as ResponseModel).commandResponse !== undefined) return resolved as ResponseModel;
    const { userNameLastFm, displayName, userId, userObj } = resolved as { userNameLastFm: string; displayName: string; userId?: number; userObj?: any };
    if (userObj && userId && UpdateService.needsUpdate(userObj, 2)) {
      void this.updateService.updateUser(userId, { accurateTotal: true });
    }
    const targetDiscordId = userObj?.discordUserId ? String(userObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (userStr ? undefined : context.accentColor);
    const timeSettings = this.settingService.getTimePeriod(period);
    const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : undefined;
    const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : undefined;
    const topArtists = await this.lastfmRepository.getTopArtists(userNameLastFm, timeSettings.timePeriod as any, 1000, 1, undefined, from, to);
    if (!topArtists || topArtists.length === 0) return GenericEmbedService.buildNotFoundResponse('No top artists found for this time period.');
    return TopBuilders.buildTopArtistsResponse(userNameLastFm, displayName, topArtists, timeSettings, 0, accentColor);
  }

  private async topAlbumsAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const { period, userStr } = this.parseArgs(raw);
    const resolved = await this.resolveUser(context, userStr);
    if ((resolved as ResponseModel).commandResponse !== undefined) return resolved as ResponseModel;
    const { userNameLastFm, displayName, userId, userObj } = resolved as { userNameLastFm: string; displayName: string; userId?: number; userObj?: any };
    if (userObj && userId && UpdateService.needsUpdate(userObj, 2)) {
      void this.updateService.updateUser(userId, { accurateTotal: true });
    }
    const targetDiscordId = userObj?.discordUserId ? String(userObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (userStr ? undefined : context.accentColor);
    const timeSettings = this.settingService.getTimePeriod(period);
    const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : undefined;
    const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : undefined;
    const topAlbums = await this.lastfmRepository.getTopAlbums(userNameLastFm, timeSettings.timePeriod as any, 1000, 1, undefined, from, to);
    if (!topAlbums || topAlbums.length === 0) return GenericEmbedService.buildNotFoundResponse('No top albums found for this time period.');
    return TopBuilders.buildTopAlbumsResponse(userNameLastFm, displayName, topAlbums, timeSettings, 0, accentColor);
  }

  private async topTracksAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const { period, userStr } = this.parseArgs(raw);
    const resolved = await this.resolveUser(context, userStr);
    if ((resolved as ResponseModel).commandResponse !== undefined) return resolved as ResponseModel;
    const { userNameLastFm, displayName, userId, userObj } = resolved as { userNameLastFm: string; displayName: string; userId?: number; userObj?: any };
    if (userObj && userId && UpdateService.needsUpdate(userObj, 2)) {
      void this.updateService.updateUser(userId, { accurateTotal: true });
    }
    const targetDiscordId = userObj?.discordUserId ? String(userObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (userStr ? undefined : context.accentColor);
    const timeSettings = this.settingService.getTimePeriod(period);
    const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : undefined;
    const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : undefined;
    const topTracks = await this.lastfmRepository.getTopTracks(userNameLastFm, timeSettings.timePeriod as any, 1000, 1, undefined, from, to);
    if (!topTracks || topTracks.length === 0) return GenericEmbedService.buildNotFoundResponse('No top tracks found for this time period.');
    return TopBuilders.buildTopTracksResponse(userNameLastFm, displayName, topTracks, timeSettings, 0, accentColor);
  }
}

