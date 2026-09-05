import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { TopBuilders } from '@bot/builders/topBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateService } from '@bot/services/updateService';

const periodChoices = [
  { name: 'Weekly (7 days)', value: 'weekly' },
  { name: 'Monthly (1 month)', value: 'monthly' },
  { name: 'Quarterly (3 months)', value: 'quarterly' },
  { name: 'Half-yearly (6 months)', value: 'halfyearly' },
  { name: 'Yearly (1 year)', value: 'yearly' },
  { name: 'Overall (All time)', value: 'overall' },
];

import { ColorService } from '@bot/services/colorService';

export class TopSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly settingService: SettingService,
    private readonly lastfmRepository: LastFmRepository,
    private readonly updateService: UpdateService,
    private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder().setName('topartists').setDescription('Top artists for a time period').addStringOption(o => o.setName('period').setDescription('Time period').addChoices(...periodChoices).setRequired(false)).addStringOption(o => o.setName('user').setDescription('User to show (default: you)').setRequired(false)) as any,
        executeAsync: (ctx) => this.topArtistsAsync(ctx),
      },
      {
        data: new SlashCommandBuilder().setName('topalbums').setDescription('Top albums for a time period').addStringOption(o => o.setName('period').setDescription('Time period').addChoices(...periodChoices).setRequired(false)).addStringOption(o => o.setName('user').setDescription('User to show (default: you)').setRequired(false)) as any,
        executeAsync: (ctx) => this.topAlbumsAsync(ctx),
      },
      {
        data: new SlashCommandBuilder().setName('toptracks').setDescription('Top tracks for a time period').addStringOption(o => o.setName('period').setDescription('Time period').addChoices(...periodChoices).setRequired(false)).addStringOption(o => o.setName('user').setDescription('User to show (default: you)').setRequired(false)) as any,
        executeAsync: (ctx) => this.topTracksAsync(ctx),
      },
    ];
  }

  private async resolveUser(context: ContextModel): Promise<{ userNameLastFm: string; displayName: string; userId?: number; userObj?: any } | ResponseModel> {
    const rawUser = context.interaction?.options.getString('user') ?? null;
    if (rawUser) {
      const mentionMatch = rawUser.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const u = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!u) return GenericEmbedService.buildNotFoundResponse(`<@${mentionMatch[1]}> is not registered.`);
        const member = context.guild?.members.cache.get(mentionMatch[1]!);
        return { userNameLastFm: u.userNameLastFm, displayName: member?.displayName ?? u.userNameLastFm, userId: u.userId, userObj: u };
      }
      const lfm = rawUser.toLowerCase().startsWith('lfm:') ? rawUser.slice(4).trim() : rawUser;
      const info = await this.userService.getUserByLastFmName(lfm);
      if (info) return { userNameLastFm: info.userNameLastFm, displayName: lfm, userId: info.userId, userObj: info };
      return { userNameLastFm: lfm, displayName: lfm };
    }
    const self = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!self) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use `/register` first.');
    return { userNameLastFm: self.userNameLastFm, displayName: context.guild?.members.cache.get(context.discordUserId)?.displayName ?? self.userNameLastFm, userId: self.userId, userObj: self };
  }

  private async topArtistsAsync(context: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveUser(context);
    if ((resolved as ResponseModel).commandResponse !== undefined) return resolved as ResponseModel;
    const { userNameLastFm, displayName, userId, userObj } = resolved as { userNameLastFm: string; displayName: string; userId?: number; userObj?: any };
    if (userObj && userId && UpdateService.needsUpdate(userObj, 2)) {
      void this.updateService.updateUser(userId, { accurateTotal: true });
    }
    const rawUser = context.interaction?.options.getString('user') ?? null;
    const targetDiscordId = userObj?.discordUserId ? String(userObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (rawUser ? undefined : context.accentColor);
    const period = context.interaction?.options.getString('period') ?? 'weekly';
    const timeSettings = this.settingService.getTimePeriod(period);
    const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : undefined;
    const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : undefined;
    const topArtists = await this.lastfmRepository.getTopArtists(userNameLastFm, timeSettings.timePeriod as any, 1000, 1, undefined, from, to);
    if (!topArtists || topArtists.length === 0) return GenericEmbedService.buildNotFoundResponse('No top artists found for this time period.');
    return TopBuilders.buildTopArtistsResponse(userNameLastFm, displayName, topArtists, timeSettings, 0, accentColor);
  }

  private async topAlbumsAsync(context: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveUser(context);
    if ((resolved as ResponseModel).commandResponse !== undefined) return resolved as ResponseModel;
    const { userNameLastFm, displayName, userId, userObj } = resolved as { userNameLastFm: string; displayName: string; userId?: number; userObj?: any };
    if (userObj && userId && UpdateService.needsUpdate(userObj, 2)) {
      void this.updateService.updateUser(userId, { accurateTotal: true });
    }
    const rawUser = context.interaction?.options.getString('user') ?? null;
    const targetDiscordId = userObj?.discordUserId ? String(userObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (rawUser ? undefined : context.accentColor);
    const period = context.interaction?.options.getString('period') ?? 'weekly';
    const timeSettings = this.settingService.getTimePeriod(period);
    const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : undefined;
    const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : undefined;
    const topAlbums = await this.lastfmRepository.getTopAlbums(userNameLastFm, timeSettings.timePeriod as any, 1000, 1, undefined, from, to);
    if (!topAlbums || topAlbums.length === 0) return GenericEmbedService.buildNotFoundResponse('No top albums found for this time period.');
    return TopBuilders.buildTopAlbumsResponse(userNameLastFm, displayName, topAlbums, timeSettings, 0, accentColor);
  }

  private async topTracksAsync(context: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveUser(context);
    if ((resolved as ResponseModel).commandResponse !== undefined) return resolved as ResponseModel;
    const { userNameLastFm, displayName, userId, userObj } = resolved as { userNameLastFm: string; displayName: string; userId?: number; userObj?: any };
    if (userObj && userId && UpdateService.needsUpdate(userObj, 2)) {
      void this.updateService.updateUser(userId, { accurateTotal: true });
    }
    const rawUser = context.interaction?.options.getString('user') ?? null;
    const targetDiscordId = userObj?.discordUserId ? String(userObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (rawUser ? undefined : context.accentColor);
    const period = context.interaction?.options.getString('period') ?? 'weekly';
    const timeSettings = this.settingService.getTimePeriod(period);
    const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : undefined;
    const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : undefined;
    const topTracks = await this.lastfmRepository.getTopTracks(userNameLastFm, timeSettings.timePeriod as any, 1000, 1, undefined, from, to);
    if (!topTracks || topTracks.length === 0) return GenericEmbedService.buildNotFoundResponse('No top tracks found for this time period.');
    return TopBuilders.buildTopTracksResponse(userNameLastFm, displayName, topTracks, timeSettings, 0, accentColor);
  }
}
