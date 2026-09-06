import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { TopTrack } from '@domain/models/topLists';
import type {
  ListeningGapItem,
  GapEntityType,
  DiscoveryItem,
  IcebergData,
  AffinityData,
} from '@bot/services/musicIntelligenceService';

export class IntelligenceBuilders {
  public static buildListeningGapsResponse(params: {
    displayName: string;
    userNameLastFm: string;
    entityType: GapEntityType;
    items: ListeningGapItem[];
    page?: number;
    pageSize?: number;
    accentColor?: number | null;
  }): ResponseModel {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(params.items.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = params.items.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const typeLabel = params.entityType.charAt(0).toUpperCase() + params.entityType.slice(1);
    const userUrl = `https://www.last.fm/user/${encodeURIComponent(params.userNameLastFm)}/library`;
    const titleText = `### ⏱️ ${typeLabel} listening gaps for [${params.displayName}](${userUrl})\n-# Showing items you returned to after a hiatus of at least 90 days`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `*No ${params.entityType} listening gaps of 90+ days found in your listening history.*`,
        ),
      );
    } else {
      const lines = currentItems.map((item, idx) => {
        const rank = startIndex + idx + 1;
        const resumeTimestamp = Math.floor(item.resumeDate.getTime() / 1000);
        let link: string;
        if (params.entityType === 'artist') {
          link = `**[${item.name}](https://www.last.fm/music/${encodeURIComponent(item.name)})**`;
        } else if (params.entityType === 'album' && item.artistName) {
          link = `**[${item.name}](https://www.last.fm/music/${encodeURIComponent(item.artistName)}/${encodeURIComponent(item.name)})** by **[${item.artistName}](https://www.last.fm/music/${encodeURIComponent(item.artistName)})**`;
        } else if (item.artistName) {
          link = `**[${item.name}](https://www.last.fm/music/${encodeURIComponent(item.artistName)}/_/${encodeURIComponent(item.name)})** by **[${item.artistName}](https://www.last.fm/music/${encodeURIComponent(item.artistName)})**`;
        } else {
          link = `**${item.name}**`;
        }

        return `${rank}. ${link} — Resumed <t:${resumeTimestamp}:D> after **${item.gapDays.toLocaleString()} days** (*${item.totalPlays.toLocaleString()} total plays*)`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# Page ${page} of ${totalPages} • Total: ${params.items.length} gaps`),
        );
      }
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildDiscoveriesResponse(params: {
    displayName: string;
    userNameLastFm: string;
    periodDescription: string;
    items: DiscoveryItem[];
    page?: number;
    pageSize?: number;
    accentColor?: number | null;
  }): ResponseModel {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(params.items.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = params.items.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(params.userNameLastFm)}/library/artists`;
    const titleText = `### ✨ Discovered artists in ${params.periodDescription} for [${params.displayName}](${userUrl})\n-# Artists listened to for the very first time in this period`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `*No newly discovered artists found in ${params.periodDescription}.*`,
        ),
      );
    } else {
      const lines = currentItems.map((item, idx) => {
        const rank = startIndex + idx + 1;
        const firstTimestamp = Math.floor(item.firstPlay.getTime() / 1000);
        const artistLink = `**[${item.artistName}](https://www.last.fm/music/${encodeURIComponent(item.artistName)})**`;
        const playStr = item.playcount === 1 ? '1 play' : `${item.playcount.toLocaleString()} plays`;
        return `${rank}. ${artistLink} — *${playStr}* — first played on <t:${firstTimestamp}:D>`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Page ${page} of ${totalPages} • Total: ${params.items.length} discovered artists`,
          ),
        );
      }
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildIcebergResponse(params: {
    data: IcebergData;
    accentColor?: number | null;
  }): ResponseModel {
    const { data } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(data.userNameLastFm)}/library/artists`;
    const titleText = `### 🧊 Taste Iceberg for [${data.displayName}](${userUrl}) (${data.timePeriodDescription})\n-# Tier classification of your top ${data.totalArtists} artists by popularity`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const tierSections: string[] = [];

    for (const tier of data.tiers) {
      if (tier.artists.length === 0) continue;
      const topArtistsStr = tier.artists
        .slice(0, 8)
        .map((a) => `[${a.name}](https://www.last.fm/music/${encodeURIComponent(a.name)})`)
        .join(', ');
      const extraCount = tier.artists.length > 8 ? ` *+${tier.artists.length - 8} more*` : '';

      tierSections.push(
        `**${tier.emoji} Tier ${tier.tierNumber}: ${tier.name}** (${tier.artists.length} artists)\n> ${topArtistsStr}${extraCount}`,
      );
    }

    if (tierSections.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('*No artists found to classify in the selected time period.*'),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tierSections.join('\n\n')));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAffinityResponse(params: {
    data: AffinityData;
    page?: number;
    pageSize?: number;
    accentColor?: number | null;
  }): ResponseModel {
    const { data } = params;
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(data.neighbors.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = data.neighbors.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(data.userNameLastFm)}`;
    const titleText = `### 🫂 Server Soulmates for [${data.userDisplayName}](${userUrl}) in ${data.guildName}\n-# Music taste similarity based on top artists, genres, and countries`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (data.neighbors.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '*Could not find indexed users with a similar music taste in this server.*',
        ),
      );
    } else {
      const lines = currentItems.map((n, idx) => {
        const rank = startIndex + idx + 1;
        const targetUrl = `https://www.last.fm/user/${encodeURIComponent(n.userNameLastFm)}`;
        const userLink = `**[${n.userNameLastFm}](${targetUrl})** (<@${n.discordUserId}>)`;
        const commonStr = n.sharedArtists.length > 0 ? ` • Common: ${n.sharedArtists.join(', ')}` : '';
        return (
          `**${rank}. ${n.totalPercentage}%** — ${userLink}\n` +
          `-# \`${n.artistPercentage}%\` artists · \`${n.genrePercentage}%\` genres · \`${n.countryPercentage}%\` countries${commonStr}`
        );
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Page ${page} of ${totalPages} • Total: ${data.neighbors.length} members compared`,
          ),
        );
      }
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildLovedTracksResponse(params: {
    displayName: string;
    userNameLastFm: string;
    tracks: TopTrack[];
    total: number;
    page?: number;
    pageSize?: number;
    accentColor?: number | null;
  }): ResponseModel {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(params.total / pageSize));
    const startIndex = (page - 1) * pageSize;

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(params.userNameLastFm)}/loved`;
    const titleText = `### ❤️ Loved tracks for [${params.displayName}](${userUrl}) (${params.total.toLocaleString()} total)`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.tracks.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('*No loved tracks found on Last.fm.*'),
      );
    } else {
      const lines = params.tracks.map((track, idx) => {
        const rank = startIndex + idx + 1;
        const trackUrl = track.url || `https://www.last.fm/music/${encodeURIComponent(track.artistName)}/_/${encodeURIComponent(track.name)}`;
        const artistUrl = `https://www.last.fm/music/${encodeURIComponent(track.artistName)}`;
        return `${rank}. **[${track.name}](${trackUrl})** by **[${track.artistName}](${artistUrl})**`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Page ${page} of ${totalPages} • Total: ${params.total.toLocaleString()} loved tracks`,
          ),
        );
      }
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildLoveSuccessResponse(
    artist: string,
    track: string,
    loved: boolean,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorRed);

    const emoji = loved ? '❤️' : '💔';
    const actionStr = loved ? 'Loved' : 'Removed from loved tracks';
    const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(track)}`;
    const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;

    const content = `${emoji} ${actionStr} **[${track}](${trackUrl})** by **[${artist}](${artistUrl})** on Last.fm!`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildScrobbleSuccessResponse(
    artist: string,
    track: string,
    album?: string,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorRed);

    const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(track)}`;
    const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
    const albumPart = album ? ` on album *${album}*` : '';

    const content = `🎶 Successfully scrobbled **[${track}](${trackUrl})** by **[${artist}](${artistUrl})**${albumPart} to Last.fm!`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
