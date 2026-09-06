import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CountryInfo, TopCountryItem, WhoKnowsCountryItem } from '@bot/services/countryService';
import { CountryChartTheme, WorldMapGenerator } from '@images/generators/worldMapGenerator';

export interface BuildTopCountriesOptions {
  displayName: string;
  countries: TopCountryItem[];
  periodDescription: string;
  pageIndex: number;
  pageSize?: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
  isServerView?: boolean;
  guildId?: string | null;
}

export interface BuildCountryArtistsOptions {
  country: CountryInfo;
  artists: { name: string; playcount: number }[];
  isServerView: boolean;
  targetName: string;
  pageIndex: number;
  pageSize?: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
  guildId?: string | null;
}

export interface BuildArtistCountryInfoOptions {
  artistName: string;
  country?: CountryInfo;
  location?: string;
  spotifyImageUrl?: string;
  userPlaycount?: number;
  accentColor?: number | null;
}

export interface BuildWhoKnowsCountryOptions {
  country: CountryInfo;
  serverName: string;
  items: WhoKnowsCountryItem[];
  pageIndex: number;
  pageSize?: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
}

export interface BuildCountryChartOptions {
  displayName: string;
  periodDescription: string;
  imageBuffer: Buffer;
  theme: CountryChartTheme;
  callerDiscordUserId: string;
  cacheKey: string;
  accentColor?: number | null;
}

export class CountryBuilders {
  public static buildTopCountriesResponse(options: BuildTopCountriesOptions): ResponseModel {
    const {
      displayName,
      countries,
      periodDescription,
      pageIndex,
      pageSize = 10,
      cacheKey,
      callerDiscordUserId,
      accentColor,
      isServerView = false,
      guildId,
    } = options;

    if (!countries || countries.length === 0) {
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### Top ${periodDescription} countries for ${displayName}`,
        ),
        new TextDisplayBuilder().setContent(
          'Sorry, no country data could be found for your top artists in the selected time period.\n\n' +
            'Listen to more music or try another time range!',
        ),
      );
      const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
      response.commandResponse = CommandResponse.NotFound;
      response.setComponentsV2Container(container);
      return response;
    }

    const totalPages = Math.ceil(countries.length / pageSize);
    const validPageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const startIdx = validPageIndex * pageSize;
    const pageItems = countries.slice(startIdx, startIdx + pageSize);

    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    const title = isServerView
      ? `### Top ${periodDescription} countries in ${displayName}`
      : `### Top ${periodDescription} countries for ${displayName}`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(title));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const lines = pageItems.map((c, i) => {
      const rank = startIdx + i + 1;
      const flag = `:flag_${c.countryCode.toLowerCase()}:`;
      const playsFormatted = c.playcount.toLocaleString();
      const playLabel = c.playcount === 1 ? 'play' : 'plays';
      const artistPart = c.artists && c.artists.length > 0
        ? ` · \`${c.artists.length} artists\``
        : c.artistCount
        ? ` · \`${c.artistCount} artists\``
        : '';
      return `${rank}. ${flag} **${c.countryName}** · *${playsFormatted} ${playLabel}*${artistPart}`;
    });

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const totalPlays = countries.reduce((sum, c) => sum + c.playcount, 0);
    const footerText =
      (totalPages > 1
        ? `-# Page ${validPageIndex + 1}/${totalPages} · `
        : '-# ') +
      `${countries.length} countries · ${totalPlays.toLocaleString()} total scrobbles`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    const navButtons: ButtonBuilder[] = [];

    if (totalPages > 1) {
      const isFirst = validPageIndex === 0;
      const isLast = validPageIndex === totalPages - 1;

      navButtons.push(
        new ButtonBuilder()
          .setCustomId(`country:page:first:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('First')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`country:page:prev:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`country:page:next:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
        new ButtonBuilder()
          .setCustomId(`country:page:last:top:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Last')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
      );
    }

    if (guildId) {
      const toggleAction = isServerView ? 'user' : 'server';
      const toggleLabel = isServerView ? 'View user overview' : 'View server overview';
      const toggleBtn = new ButtonBuilder()
        .setCustomId(
          `country:toggle:${toggleAction}:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`,
        )
        .setLabel(toggleLabel)
        .setStyle(ButtonStyle.Secondary);

      if (navButtons.length === 0) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBtn);
        actionRows.push(row);
        container.addActionRowComponents(row);
      } else if (navButtons.length < 4) {
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

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    actionRows.forEach((row, idx) => response.addButtonRow(idx, row));
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildCountryArtistsResponse(options: BuildCountryArtistsOptions): ResponseModel {
    const {
      country,
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

    const flag = `:flag_${country.Code.toLowerCase()}:`;

    if (!artists || artists.length === 0) {
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### ${flag} Top ${country.Name} artists for ${targetName}`,
        ),
        new TextDisplayBuilder().setContent(
          `Sorry, no registered artists found from **${country.Name}** in ${isServerView ? 'this server' : 'your library'}.`,
        ),
      );
      const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
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
      new TextDisplayBuilder().setContent(
        `### ${flag} Top ${country.Name} artists for ${targetName}`,
      ),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const lines = pageItems.map((a, i) => {
      const rank = startIdx + i + 1;
      const playsFormatted = a.playcount.toLocaleString();
      const playLabel = a.playcount === 1 ? 'play' : 'plays';
      return `${rank}. **${a.name}** · *${playsFormatted} ${playLabel}*`;
    });

    let contentString = lines.join('\n');
    if (country.Code.toUpperCase() === 'UA') {
      contentString += '\n\n:flag_ua: [Stand For Ukraine](https://standforukraine.com/)';
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(contentString));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const totalPlays = artists.reduce((sum, a) => sum + a.playcount, 0);
    const viewLabel = isServerView ? 'Server overview' : 'User overview';
    const footerText =
      `-# ${viewLabel} · ${artists.length} artists · ${totalPlays.toLocaleString()} total plays` +
      (totalPages > 1 ? ` · Page ${validPageIndex + 1}/${totalPages}` : '');

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    const navButtons: ButtonBuilder[] = [];

    if (totalPages > 1) {
      const isFirst = validPageIndex === 0;
      const isLast = validPageIndex === totalPages - 1;

      navButtons.push(
        new ButtonBuilder()
          .setCustomId(`country:page:first:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('First')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`country:page:prev:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`country:page:next:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
        new ButtonBuilder()
          .setCustomId(`country:page:last:info:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Last')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
      );
    }

    if (guildId) {
      const toggleAction = isServerView ? 'user' : 'server';
      const toggleLabel = isServerView ? 'View user overview' : 'View server overview';
      const toggleBtn = new ButtonBuilder()
        .setCustomId(
          `country:toggle:${toggleAction}:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`,
        )
        .setLabel(toggleLabel)
        .setStyle(ButtonStyle.Secondary);

      if (navButtons.length === 0) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBtn);
        actionRows.push(row);
        container.addActionRowComponents(row);
      } else if (navButtons.length < 4) {
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

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    actionRows.forEach((row, idx) => response.addButtonRow(idx, row));
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistCountryInfoResponse(
    options: BuildArtistCountryInfoOptions,
  ): ResponseModel {
    const { artistName, country, location, spotifyImageUrl, userPlaycount, accentColor } = options;

    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    if (!country) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `Could not find country of origin for **${artistName}**.\n\n` +
            `Artist locations are sourced from MusicBrainz. If this artist is missing country data, consider adding it on MusicBrainz!`,
        ),
      );
      const response = new ResponseModel(accentColor ?? DiscordConstants.WarningColorOrange);
      response.commandResponse = CommandResponse.NotFound;
      response.setComponentsV2Container(container);
      return response;
    }

    const flag = `:flag_${country.Code.toLowerCase()}:`;

    if (spotifyImageUrl) {
      const mediaItem = new MediaGalleryItemBuilder().setURL(spotifyImageUrl);
      container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(mediaItem));
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${flag} ${artistName}`),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    let desc = `From **${country.Name}**`;
    if (location && location.toLowerCase() !== country.Name.toLowerCase()) {
      desc += ` (*${location}*)`;
    }

    if (userPlaycount !== undefined && userPlaycount > 0) {
      const playLabel = userPlaycount === 1 ? 'play' : 'plays';
      desc += `\n\nYou have **${userPlaycount.toLocaleString()}** ${playLabel} for this artist.`;
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(desc));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const footerText = '-# Country data sourced from MusicBrainz & Last.fm';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildWhoKnowsCountryResponse(options: BuildWhoKnowsCountryOptions): ResponseModel {
    const {
      country,
      serverName,
      items,
      pageIndex,
      pageSize = 10,
      cacheKey,
      callerDiscordUserId,
      accentColor,
    } = options;

    const flag = `:flag_${country.Code.toLowerCase()}:`;

    if (!items || items.length === 0) {
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### ${flag} Who knows ${country.Name} in ${serverName}?`,
        ),
        new TextDisplayBuilder().setContent(
          `Nobody in **${serverName}** has listened to artists from **${country.Name}** yet!`,
        ),
      );
      const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
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
      new TextDisplayBuilder().setContent(
        `### ${flag} Who knows ${country.Name} in ${serverName}?`,
      ),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const lines = pageItems.map((item, i) => {
      const rank = startIdx + i + 1;
      const playsFormatted = item.playcount.toLocaleString();
      const playLabel = item.playcount === 1 ? 'play' : 'plays';
      return `${rank}. <@${item.discordUserId}> (**${item.userNameLastFm}**) · *${playsFormatted} ${playLabel}*`;
    });

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const totalPlays = items.reduce((sum, item) => sum + item.playcount, 0);
    const footerText =
      (totalPages > 1
        ? `-# Page ${validPageIndex + 1}/${totalPages} · `
        : '-# ') +
      `${items.length} listeners · ${totalPlays.toLocaleString()} total scrobbles`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (totalPages > 1) {
      const isFirst = validPageIndex === 0;
      const isLast = validPageIndex === totalPages - 1;

      const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`country:page:first:wkc:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('First')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`country:page:prev:wkc:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isFirst),
        new ButtonBuilder()
          .setCustomId(`country:page:next:wkc:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
        new ButtonBuilder()
          .setCustomId(`country:page:last:wkc:${cacheKey}:${validPageIndex}:${callerDiscordUserId}`)
          .setLabel('Last')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(isLast),
      );
      actionRows.push(navRow);
      container.addActionRowComponents(navRow);
    }

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    actionRows.forEach((row, idx) => response.addButtonRow(idx, row));
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildCountryChartResponse(options: BuildCountryChartOptions): ResponseModel {
    const {
      displayName,
      periodDescription,
      imageBuffer,
      theme,
      callerDiscordUserId,
      cacheKey,
      accentColor,
    } = options;

    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### Top ${periodDescription} artist countries for ${displayName}`,
      ),
    );

    const mediaItem = new MediaGalleryItemBuilder().setURL('attachment://artist-map.png');
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(mediaItem));

    // Theme selector dropdown
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`country:theme:${cacheKey}:${callerDiscordUserId}`)
      .setPlaceholder('Change map theme...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Dark')
          .setValue('dark')
          .setDescription('Deep dark theme with crisp neon blue accents')
          .setDefault(theme === CountryChartTheme.Dark),
        new StringSelectMenuOptionBuilder()
          .setLabel('Light')
          .setValue('light')
          .setDescription('Clean bright theme with deep navy ocean')
          .setDefault(theme === CountryChartTheme.Light),
        new StringSelectMenuOptionBuilder()
          .setLabel('Ocean')
          .setValue('ocean')
          .setDescription('Warm maritime theme with sepia lands & fiery heatmap')
          .setDefault(theme === CountryChartTheme.Ocean),
        new StringSelectMenuOptionBuilder()
          .setLabel('Synthwave')
          .setValue('synthwave')
          .setDescription('Cyberpunk synthwave theme with electric purples & pinks')
          .setDefault(theme === CountryChartTheme.Synthwave),
        new StringSelectMenuOptionBuilder()
          .setLabel('Sunset')
          .setValue('sunset')
          .setDescription('Dramatic dusk palette with golden yellow & ruby red')
          .setDefault(theme === CountryChartTheme.Sunset),
        new StringSelectMenuOptionBuilder()
          .setLabel('Forest')
          .setValue('forest')
          .setDescription('Earthy evergreen botanical theme with emerald greens')
          .setDefault(theme === CountryChartTheme.Forest),
      );

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    container.addActionRowComponents(selectRow);

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setFile(imageBuffer, 'artist-map.png', `World artist map for ${displayName}`);
    response.addButtonRow(0, selectRow as any);
    response.setComponentsV2Container(container);
    return response;
  }
}
