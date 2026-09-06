import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { TopGenreItem, WhoKnowsGenreItem } from '@bot/services/genreService';

function toTitleCase(str: string): string {
  return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
}

export interface BuildTopGenresOptions {
  displayName: string;
  genres: TopGenreItem[];
  periodDescription: string;
  pageIndex: number;
  pageSize?: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
}

export interface BuildGenreArtistsOptions {
  genreName: string;
  artists: { artistName: string; userPlaycount: number }[];
  isServerView: boolean;
  targetName: string;
  pageIndex: number;
  pageSize?: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
  guildId?: string | null;
}

export interface BuildWhoKnowsGenreOptions {
  genreName: string;
  serverName: string;
  items: WhoKnowsGenreItem[];
  pageIndex: number;
  pageSize?: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
}

export class GenreBuilders {
  public static buildTopGenresResponse(options: BuildTopGenresOptions): ResponseModel {
    const {
      displayName,
      genres,
      periodDescription,
      pageIndex,
      pageSize = 10,
      cacheKey,
      callerDiscordUserId,
      accentColor,
    } = options;

    if (!genres || genres.length === 0) {
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Top ${periodDescription} genres for ${displayName}`),
        new TextDisplayBuilder().setContent(
          'Sorry, no genre data could be found for your top artists in the selected time period.\n\n' +
            'Please try again later or listen to more music to populate genres!',
        ),
      );
      const response = new ResponseModel(accentColor);
      response.commandResponse = CommandResponse.NotFound;
      response.setComponentsV2Container(container);
      return response;
    }

    const totalPages = Math.ceil(genres.length / pageSize);
    const validPageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const startIdx = validPageIndex * pageSize;
    const pageItems = genres.slice(startIdx, startIdx + pageSize);

    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Top ${periodDescription} genres for ${displayName}`),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const lines = pageItems.map((g, i) => {
      const rank = startIdx + i + 1;
      const title = toTitleCase(g.genreName);
      const playsFormatted = g.userPlaycount.toLocaleString();
      const playLabel = g.userPlaycount === 1 ? 'play' : 'plays';
      const artistsList = g.topArtists && g.topArtists.length > 0 ? ` · *(${g.topArtists.join(', ')})*` : '';
      return `${rank}. **${title}** · *${playsFormatted} ${playLabel}*${artistsList}`;
    });

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const footerText = totalPages > 1
      ? `-# Page ${validPageIndex + 1}/${totalPages} · ${genres.length} total genres`
      : `-# ${genres.length} total genres`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(footerText),
    );

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (totalPages > 1) {
      const isFirst = validPageIndex === 0;
      const isLast = validPageIndex === totalPages - 1;

      const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`genre:page:first:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('First')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`genre:page:prev:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`genre:page:next:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
        new ButtonBuilder()
          .setCustomId(`genre:page:last:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Last')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
      );

      actionRows.push(navRow);
      container.addActionRowComponents(navRow);
    }

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildGenreArtistsResponse(options: BuildGenreArtistsOptions): ResponseModel {
    const {
      genreName,
      artists,
      isServerView,
      targetName,
      pageIndex,
      pageSize = 10,
      cacheKey,
      callerDiscordUserId,
      accentColor,
      guildId,
    } = options;

    const titleGenre = toTitleCase(genreName);
    const viewLabel = isServerView ? 'Server view' : 'User view';

    if (!artists || artists.length === 0) {
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Top '${titleGenre}' artists for ${targetName}`),
        new TextDisplayBuilder().setContent(
          `Sorry, no registered artists found for **${titleGenre}** in ${isServerView ? 'this server' : 'your library'}.`,
        ),
      );
      const response = new ResponseModel(accentColor);
      response.commandResponse = CommandResponse.NotFound;
      response.setComponentsV2Container(container);
      return response;
    }

    const totalPages = Math.ceil(artists.length / pageSize);
    const validPageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const startIdx = validPageIndex * pageSize;
    const pageItems = artists.slice(startIdx, startIdx + pageSize);

    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Top '${titleGenre}' artists for ${targetName}`),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const lines = pageItems.map((a, i) => {
      const rank = startIdx + i + 1;
      const playsFormatted = a.userPlaycount.toLocaleString();
      const playLabel = a.userPlaycount === 1 ? 'play' : 'plays';
      return `${rank}. **${a.artistName}** · *${playsFormatted} ${playLabel}*`;
    });

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const totalPlays = artists.reduce((sum, a) => sum + a.userPlaycount, 0);
    const footerText = `-# ${viewLabel} · ${artists.length} artists · ${totalPlays.toLocaleString()} total plays` +
      (totalPages > 1 ? ` · Page ${validPageIndex + 1}/${totalPages}` : '');

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(footerText),
    );

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    const navButtons: ButtonBuilder[] = [];

    if (totalPages > 1) {
      const isFirst = validPageIndex === 0;
      const isLast = validPageIndex === totalPages - 1;

      navButtons.push(
        new ButtonBuilder()
          .setCustomId(`genre:page:first:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('First')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`genre:page:prev:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`genre:page:next:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
        new ButtonBuilder()
          .setCustomId(`genre:page:last:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Last')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
      );
    }

    if (guildId) {
      const toggleAction = isServerView ? 'user' : 'server';
      const toggleLabel = isServerView ? 'View user overview' : 'View server overview';
      const toggleBtn = new ButtonBuilder()
        .setCustomId(`genre:toggle:${toggleAction}:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
        .setLabel(toggleLabel)
        .setStyle(ButtonStyle.Secondary);

      if (navButtons.length < 4) {
        navButtons.push(toggleBtn);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(navButtons);
        actionRows.push(row);
        container.addActionRowComponents(row);
      } else {
        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(navButtons);
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBtn);
        actionRows.push(row1, row2);
        container.addActionRowComponents(row1, row2);
      }
    } else if (navButtons.length > 0) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(navButtons);
      actionRows.push(row);
      container.addActionRowComponents(row);
    }

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistGenresResponse(
    artistName: string,
    genres: string[],
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Genres for '${artistName}'`),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    if (!genres || genres.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('*No registered genres or tags found for this artist.*'),
      );
    } else {
      const formatted = genres.map(g => `- **${toTitleCase(g)}**`).join('\n');
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(formatted),
      );
    }

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# Sourced from Last.fm tags & Spotify genres'),
    );

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildWhoKnowsGenreResponse(options: BuildWhoKnowsGenreOptions): ResponseModel {
    const {
      genreName,
      serverName,
      items,
      pageIndex,
      pageSize = 12,
      cacheKey,
      callerDiscordUserId,
      accentColor,
    } = options;

    const titleGenre = toTitleCase(genreName);

    if (!items || items.length === 0) {
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### '${titleGenre}' in ${serverName}`),
        new TextDisplayBuilder().setContent(
          `Nobody in **${serverName}** has registered scrobbles for **${titleGenre}** yet.`,
        ),
      );
      const response = new ResponseModel(accentColor);
      response.commandResponse = CommandResponse.NotFound;
      response.setComponentsV2Container(container);
      return response;
    }

    const totalPages = Math.ceil(items.length / pageSize);
    const validPageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const startIdx = validPageIndex * pageSize;
    const pageItems = items.slice(startIdx, startIdx + pageSize);

    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### '${titleGenre}' in ${serverName}`),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const lines = pageItems.map((u, i) => {
      const rank = startIdx + i + 1;
      const playsFormatted = u.playcount.toLocaleString();
      const playLabel = u.playcount === 1 ? 'play' : 'plays';
      const isCaller = u.discordUserId === callerDiscordUserId;
      const nameDisplay = isCaller ? `__**${u.userNameLastFm}**__` : `**${u.userNameLastFm}**`;
      return `${rank}. ${nameDisplay} · *${playsFormatted} ${playLabel}*`;
    });

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const totalListeners = items.length;
    const totalPlays = items.reduce((sum, item) => sum + item.playcount, 0);
    const avgPlays = Math.round(totalPlays / Math.max(1, totalListeners));

    const footerText = `-# ${totalListeners} listeners · ${totalPlays.toLocaleString()} total plays · avg ${avgPlays.toLocaleString()} plays` +
      (totalPages > 1 ? `\n-# Page ${validPageIndex + 1}/${totalPages}` : '');

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(footerText),
    );

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (totalPages > 1) {
      const isFirst = validPageIndex === 0;
      const isLast = validPageIndex === totalPages - 1;

      const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`genre:page:first:whoknows:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('First')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`genre:page:prev:whoknows:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`genre:page:next:whoknows:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
        new ButtonBuilder()
          .setCustomId(`genre:page:last:whoknows:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Last')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
      );

      actionRows.push(navRow);
      container.addActionRowComponents(navRow);
    }

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
