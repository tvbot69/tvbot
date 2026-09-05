import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { TasteData, formatTasteTable } from '@bot/services/tasteService';

export class TasteBuilders {
  public static buildTasteResponse(
    data: TasteData,
    tabIndex: number = 0,
    amount: number = 14,
    accentColor?: number,
  ): ResponseModel {
    let tabLabel = 'artist';
    let typeColumn = 'Artist';
    let items = data.artists.items;
    let totalCount = data.artists.totalCount;

    if (tabIndex === 1) {
      tabLabel = 'genre';
      typeColumn = 'Genre';
      items = data.genres.items;
      totalCount = data.genres.totalCount;
    } else if (tabIndex === 2) {
      tabLabel = 'country';
      typeColumn = 'Country';
      items = data.countries.items;
      totalCount = data.countries.totalCount;
    }

    const { tableText, matchesCount, matchPercentage } = formatTasteTable(
      typeColumn,
      data.user1UserNameLastFm,
      data.user2UserNameLastFm,
      items,
      amount,
      totalCount,
      data.timePeriodDescription,
    );

    const titleMarkdown = `### [Top ${tabLabel} comparison — ${data.user1DisplayName} vs ${data.user2DisplayName}](${data.url})`;
    const bodyMarkdown = `-# **${matchesCount}** matches (${matchPercentage.toFixed(1)}%) out of top **${totalCount}** ${data.timePeriodDescription}\n\`\`\`${tableText}\`\`\``;

    const row = new ActionRowBuilder<ButtonBuilder>();

    const nextAmount = amount === 14 ? 28 : 14;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`taste-tab:${data.cacheKey}:0:${data.user1DiscordId}:${data.user2DiscordId}:${data.timePeriodDescription}:${amount}`)
        .setLabel('Artists')
        .setStyle(tabIndex === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tabIndex === 0),
      new ButtonBuilder()
        .setCustomId(`taste-tab:${data.cacheKey}:1:${data.user1DiscordId}:${data.user2DiscordId}:${data.timePeriodDescription}:${amount}`)
        .setLabel('Genres')
        .setStyle(tabIndex === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tabIndex === 1),
      new ButtonBuilder()
        .setCustomId(`taste-tab:${data.cacheKey}:2:${data.user1DiscordId}:${data.user2DiscordId}:${data.timePeriodDescription}:${amount}`)
        .setLabel('Countries')
        .setStyle(tabIndex === 2 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tabIndex === 2),
      new ButtonBuilder()
        .setCustomId(`taste-tab:${data.cacheKey}:${tabIndex}:${data.user1DiscordId}:${data.user2DiscordId}:${data.timePeriodDescription}:${nextAmount}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji({ id: '1483232894318149692', name: 'plus' } as any),
    );

    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(titleMarkdown))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyMarkdown))
      .addActionRowComponents(row);

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
