import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, StringSelectMenuBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder, SeparatorSpacingSize } from 'discord.js';
import { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import type { LastFmUser } from '@domain/models/lastFmUser';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { FmEmbedType, FmEmbedTypeNames } from '@domain/enums/fmEmbedType';
import { FmFooterOption, FmFooterOptionMeta } from '@domain/enums/fmFooterOption';
import { FmAccentColor } from '@domain/enums/fmAccentColor';
import { FmButton, FmButtonMetaList } from '@domain/enums/fmButton';
import { FmTextType } from '@domain/enums/fmTextType';
import { buildFooterText } from './footerBuilder';

const lastfmTrackUrl = (artist: string, track: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;
const lastfmUserUrl = (userName: string): string =>
  `https://last.fm/user/${encodeURIComponent(userName)}`;
const lastfmArtistUrl = (artist: string): string => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;
const lastfmAlbumUrl = (artist: string, album: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;

function resolveEmbedType(stored: number | undefined, guildType: number | null | undefined, channelType: number | null | undefined, inline: FmEmbedType | null): FmEmbedType {
  let t: FmEmbedType = inline ?? (stored as FmEmbedType | undefined) ?? FmEmbedType.EmbedMini;
  if (guildType !== null && guildType !== undefined) t = guildType as FmEmbedType;
  if (channelType !== null && channelType !== undefined) t = channelType as FmEmbedType;
  return t;
}

function toDisplayScrobbles(n?: number): string {
  if (!n) return '0';
  return n.toLocaleString();
}

function getAccentColor(setting: { accentColor: number | null; customColor: string | null } | null, userAccent?: number): number | undefined {
  if (setting?.accentColor === FmAccentColor.LastFmRed) return DiscordConstants.LastFmColorRed;
  if (setting?.accentColor === FmAccentColor.Custom) {
    const color = setting.customColor?.replace(/^#/, '');
    if (color && /^[0-9a-f]{6}$/i.test(color)) return parseInt(color, 16);
  }
  return userAccent;
}

function getLinkButtons(setting: { buttons: bigint } | null, track: RecentTrack, userName: string): ActionRowBuilder<ButtonBuilder> | null {
  const enabled = setting?.buttons ?? BigInt(0);
  const has = (flag: FmButton) => (enabled & BigInt(flag)) !== BigInt(0);
  const buttons: ButtonBuilder[] = [];
  if (has(FmButton.LastFmTrackLink)) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Track').setURL(lastfmTrackUrl(track.artistName, track.name)));
  if (track.albumName && has(FmButton.LastFmAlbumLink)) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Album').setURL(lastfmAlbumUrl(track.artistName, track.albumName)));
  if (has(FmButton.LastFmArtistLink)) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Artist').setURL(lastfmArtistUrl(track.artistName)));
  if (has(FmButton.LastFmUserLibraryLink)) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Library').setURL(lastfmUserUrl(userName)));
  return buttons.length ? new ActionRowBuilder<ButtonBuilder>().addComponents(buttons) : null;
}

export class PlayBuilders {
  public static buildFmResponse(
    context: ContextModel,
    user: User,
    tracks: RecentTrack[],
    lastFmUser: LastFmUser | null,
    opts?: {
      fmSetting?: { embedType: number; footerOptions: bigint; smallTextType: number | null; accentColor: number | null; customColor: string | null; buttons: bigint } | null;
      guildFmType?: number | null;
      channelFmType?: number | null;
      inlineEmbedType?: FmEmbedType | null;
      artistPlays?: number;
      albumPlays?: number;
      trackPlays?: number;
      differentUser?: boolean;
    },
  ): ResponseModel {
    const track = tracks[0];
    if (!track || !track.name) {
      return GenericEmbedService.buildNotFoundResponse('No scrobbles found on your Last.fm profile.');
    }

    const fmSetting = opts?.fmSetting ?? null;
    const embedType = resolveEmbedType(fmSetting?.embedType as number | undefined, opts?.guildFmType ?? null, opts?.channelFmType ?? null, opts?.inlineEmbedType ?? null);
    const useSmallText = fmSetting?.smallTextType !== null && fmSetting?.smallTextType !== undefined && fmSetting.smallTextType !== FmTextType.NormalText;
    const footerOptions = fmSetting ? (fmSetting.footerOptions as bigint) : BigInt(FmFooterOption.TotalScrobbles);
    const rawFooter = buildFooterText({
      footerOptions: footerOptions as unknown as bigint,
      track,
      previousTrack: tracks[1] ?? null,
      totalScrobbles: lastFmUser?.playCount,
      artistPlays: opts?.artistPlays,
      albumPlays: opts?.albumPlays,
      trackPlays: opts?.trackPlays,
      useSmallText,
    });
    const footerText = rawFooter || `${toDisplayScrobbles(lastFmUser?.playCount)} total scrobbles`;

    const fallbackColor = opts?.differentUser ? undefined : context.accentColor;
    const accent = getAccentColor(fmSetting, fallbackColor);

    // Text variants still use legacy embed for speed, but Embed types use Components V2 to match fmbot
    if (embedType === FmEmbedType.TextOneLine) {
      const response = new ResponseModel(accent);
      response.commandResponse = CommandResponse.Ok;
      response.embed.setDescription(`${track.artistName} - ${track.name}`);
      return response;
    }
    if (embedType === FmEmbedType.TextMini) {
      const response = new ResponseModel(accent);
      response.commandResponse = CommandResponse.Ok;
      const line = `**[${track.name}](${lastfmTrackUrl(track.artistName, track.name)})** by **${track.artistName}**`;
      // TextMini stays embed for now
      response.embed.setDescription(`${line}\n${footerText}`);
      if (track.imageUrl) response.embed.setThumbnail(track.imageUrl);
      return response;
    }
    if (embedType === FmEmbedType.TextFull) {
      const response = new ResponseModel(accent);
      response.commandResponse = CommandResponse.Ok;
      const current = `**[${track.name}](${lastfmTrackUrl(track.artistName, track.name)})** by ${track.artistName}${track.albumName ? ` — *${track.albumName}*` : ''}`;
      const prev = tracks[1] ? `\nPrevious: **${tracks[1].name}** by ${tracks[1].artistName}` : '';
      response.embed.setDescription(`${current}${prev}\n${footerText}`);
      if (track.imageUrl) response.embed.setThumbnail(track.imageUrl);
      return response;
    }

    // === EmbedTiny / EmbedMini / EmbedFull — Components V2 ===
    const coverUrl = track.imageUrl || null;

    const trackLink = `[${track.name}](${lastfmTrackUrl(track.artistName, track.name)})`;
    const headerPrefix = '-# ';
    const relativeTime = track.timePlayed ? `<t:${Math.floor(track.timePlayed.getTime() / 1000)}:R>` : 'recently';
    const displayName = context.member?.displayName
      ?? user.userNameLastFm;
    const displayUserLink = `[${displayName}](<${lastfmUserUrl(user.userNameLastFm)}>)`;
    const header = track.nowPlaying
      ? `${headerPrefix}Now playing for ${displayUserLink}`
      : `${headerPrefix}Last played ${relativeTime} for ${displayUserLink}`;
    const trackContent = `### ${trackLink}\n**${track.artistName}**${track.albumName ? ` • *${track.albumName}*` : ''}`;
    const linkButtons = getLinkButtons(fmSetting, track, user.userNameLastFm);

    if (embedType === FmEmbedType.EmbedTiny) {
      const container = new ContainerBuilder();
      if (accent !== undefined && accent !== null) container.setAccentColor(accent);
      container
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(trackContent))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerText.replace(/^-#\s*/, '')}`));
      if (linkButtons) container.addActionRowComponents(linkButtons);
      const response = new ResponseModel(accent);
      response.commandResponse = CommandResponse.Ok;
      response.setComponentsV2Container(container);
      return response;
    }

    // EmbedMini — single track with cover
    if (embedType === FmEmbedType.EmbedMini) {
      const container = new ContainerBuilder();
      if (accent !== undefined && accent !== null) container.setAccentColor(accent);
      if (coverUrl) {
        const section = new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${trackContent}`))
          .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: coverUrl } }));
        container.addSectionComponents(section);
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${trackContent}`));
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerText.replace(/^-#\s*/, '')}`));
      if (linkButtons) container.addActionRowComponents(linkButtons);
      const response = new ResponseModel(accent);
      response.commandResponse = CommandResponse.Ok;
      response.setComponentsV2Container(container);
      return response;
    }

    // EmbedFull — current + previous
    {
      const container = new ContainerBuilder();
      if (accent !== undefined && accent !== null) container.setAccentColor(accent);
      if (coverUrl) {
        const section = new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${trackContent}`))
          .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: coverUrl } }));
        container.addSectionComponents(section);
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${trackContent}`));
      }
      if (tracks[1]) {
        const prev = tracks[1];
        const prevLink = `[${prev.name}](${lastfmTrackUrl(prev.artistName, prev.name)})`;
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Previous: ${prevLink} — ${prev.artistName}`));
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerText.replace(/^-#\s*/, '')}`));
      if (linkButtons) container.addActionRowComponents(linkButtons);
      const response = new ResponseModel(accent);
      response.commandResponse = CommandResponse.Ok;
      response.setComponentsV2Container(container);
      return response;
    }
  }

  public static buildFmModeResponse(
    setting: { embedType: number; footerOptions: bigint; buttons: bigint; accentColor: number | null; customColor: string | null; smallTextType: number | null },
    accentColor?: number,
  ): ResponseModel {
    const typeName = (FmEmbedTypeNames as Record<number,string>)[setting.embedType] ?? String(setting.embedType);
    const selectedFooter = Number(setting.footerOptions);
    const selectedButtons = Number(setting.buttons);
    const typeMenu = new StringSelectMenuBuilder()
      .setCustomId('fmmode:type')
      .setPlaceholder(`Layout: ${typeName}`)
      .addOptions(Object.entries(FmEmbedTypeNames).map(([value, label]) => ({ label, value, default: Number(value) === setting.embedType })));
    const accentMenu = new StringSelectMenuBuilder()
      .setCustomId('fmmode:accent')
      .setPlaceholder('Accent color')
      .addOptions([
        { label: 'Neutral cover', value: String(FmAccentColor.CoverColor), default: setting.accentColor === FmAccentColor.CoverColor || setting.accentColor === null },
        { label: 'Last.fm red', value: String(FmAccentColor.LastFmRed), default: setting.accentColor === FmAccentColor.LastFmRed },
        { label: 'Server color', value: String(FmAccentColor.GuildColor), default: setting.accentColor === FmAccentColor.GuildColor },
      ]);
    const textMenu = new StringSelectMenuBuilder()
      .setCustomId('fmmode:text')
      .setPlaceholder('Text size')
      .addOptions([
        { label: 'Normal text', value: String(FmTextType.NormalText), default: setting.smallTextType !== FmTextType.SmallText },
        { label: 'Small text', value: String(FmTextType.SmallText), default: setting.smallTextType === FmTextType.SmallText },
      ]);
    const footerMenu = new StringSelectMenuBuilder()
      .setCustomId('fmmode:footer')
      .setPlaceholder('Footer details')
      .setMinValues(0)
      .setMaxValues(FmFooterOptionMeta.length)
      .addOptions(FmFooterOptionMeta.map(({ flag, label, description }) => ({ label, description, value: String(flag), default: (selectedFooter & flag) !== 0 })));
    const linkButtonOptions = FmButtonMetaList.filter((button) => button.isLink && button.flag !== FmButton.SpotifyLink);
    const buttonMenu = new StringSelectMenuBuilder()
      .setCustomId('fmmode:buttons')
      .setPlaceholder('Track link buttons')
      .setMinValues(0)
      .setMaxValues(linkButtonOptions.length)
      .addOptions(linkButtonOptions.map(({ flag, label, emoji }) => ({ label, emoji, value: String(flag), default: (selectedButtons & flag) !== 0 })));
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## FM Mode\nCurrent layout: **${typeName}**\nChanges save immediately and affect your own \`.fm\` responses.`))
      .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeMenu))
      .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(accentMenu))
      .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(textMenu))
      .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(footerMenu))
      .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buttonMenu));
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildRegisterSuccessResponse(userNameLastFm: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.embed.setDescription(`Your Last.fm username has been set to **${userNameLastFm}**.`);
    return response;
  }
}
