import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { UserCrownDto, CrownViewType, CrownLeaderboardEntry } from '@domain/models/crownModels';

const lastfmArtistUrl = (artist: string): string =>
  `https://last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;

const lastfmUserUrl = (username: string): string =>
  `https://last.fm/user/${encodeURIComponent(username)}`;

const lastfmUserArtistUrl = (username: string, artist: string): string =>
  `https://last.fm/user/${encodeURIComponent(username)}/library/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;

export class CrownBuilders {
  public static buildCrownsResponse(
    displayName: string,
    callerDiscordId: string,
    targetDiscordId: string,
    crowns: UserCrownDto[],
    page: number = 1,
    viewType: CrownViewType = 'Playcount',
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const totalCount = crowns.length;
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const clampedPage = Math.min(totalPages, Math.max(1, page));
    const startIdx = (clampedPage - 1) * pageSize;
    const pageCrowns = crowns.slice(startIdx, startIdx + pageSize);

    // 1. Header
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Crowns for ${displayName}`),
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    // 2. Lines
    if (pageCrowns.length === 0) {
      const emptyMsg =
        viewType === 'Stolen'
          ? 'No stolen crowns found.'
          : `${displayName} does not have any crowns in this server yet.`;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(emptyMsg));
    } else {
      const lines = pageCrowns.map((c, i) => {
        const rank = startIdx + i + 1;
        const timestampSeconds = Math.floor(new Date(viewType === 'Stolen' ? c.modified : c.created).getTime() / 1000);
        const actionLabel = viewType === 'Stolen' ? 'Lost' : 'Claimed';
        return `${rank}. **${c.artistName}** — *${c.currentPlaycount.toLocaleString()} plays* — ${actionLabel} <t:${timestampSeconds}:R>`;
      });

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n')),
      );
    }

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    // 3. Footer
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Page ${clampedPage}/${totalPages} - ${totalCount} total crowns`,
      ),
    );

    // 4. Select menu for views
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('user-crownpicker')
      .setPlaceholder('Select crown view')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([
        {
          label: 'Active crowns ordered by playcount',
          value: `${callerDiscordId}-${targetDiscordId}-Playcount`,
          default: viewType === 'Playcount',
        },
        {
          label: 'Recently obtained crowns',
          value: `${callerDiscordId}-${targetDiscordId}-Recent`,
          default: viewType === 'Recent',
        },
        {
          label: 'Recently stolen crowns',
          value: `${callerDiscordId}-${targetDiscordId}-Stolen`,
          default: viewType === 'Stolen',
        },
      ]);

    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );

    // 5. Pagination Buttons
    const paginatorRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`crowns-page:first:${callerDiscordId}:${targetDiscordId}:${viewType}:${clampedPage}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(clampedPage <= 1)
        .setEmoji({ id: '883825508633182208', name: 'pages_first' } as any),
      new ButtonBuilder()
        .setCustomId(`crowns-page:prev:${callerDiscordId}:${targetDiscordId}:${viewType}:${clampedPage}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(clampedPage <= 1)
        .setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any),
      new ButtonBuilder()
        .setCustomId(`crowns-page:next:${callerDiscordId}:${targetDiscordId}:${viewType}:${clampedPage}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(clampedPage >= totalPages)
        .setEmoji({ id: '883825508087922739', name: 'pages_next' } as any),
      new ButtonBuilder()
        .setCustomId(`crowns-page:last:${callerDiscordId}:${targetDiscordId}:${viewType}:${clampedPage}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(clampedPage >= totalPages)
        .setEmoji({ id: '883825508482183258', name: 'pages_last' } as any),
      new ButtonBuilder()
        .setCustomId(`crowns-page:jump:${callerDiscordId}:${targetDiscordId}:${viewType}:${clampedPage}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji({ id: '1138849626234036264', name: 'pages_goto' } as any),
    );

    container.addActionRowComponents(paginatorRow);

    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildCrownDuelResponse(
    artistName: string,
    currentCrown: UserCrownDto | null,
    holderDisplayName?: string,
    challenger?: {
      displayName: string;
      userNameLastFm: string;
      playcount: number;
    } | null,
    history?: UserCrownDto[],
    accentColor?: number,
    artistId?: number | null,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;

    const artistLink = `[${artistName}](${lastfmArtistUrl(artistName)})`;

    if (!currentCrown) {
      const embed = new EmbedBuilder()
        .setTitle(`Crown for ${artistName}`)
        .setDescription(`Nobody holds the crown for ${artistLink} in this server yet.`);
      
      if (accentColor !== undefined && accentColor !== null) {
        embed.setColor(accentColor);
      }

      if (challenger && challenger.playcount > 0) {
        embed.setDescription(
          `👑 → *No active crown holder*\n⚔️ → [${challenger.displayName}](${lastfmUserUrl(challenger.userNameLastFm)}) — **${challenger.playcount.toLocaleString()} plays**\n\nReach the required plays threshold to claim the crown for ${artistLink}!`,
        );
      }

      response.embed = embed;
      return response;
    }

    const holderName = holderDisplayName ?? currentCrown.userNameLastFm ?? 'User';
    const holderUrl = lastfmUserUrl(currentCrown.userNameLastFm ?? holderName);
    const playsFormatted = currentCrown.currentPlaycount.toLocaleString();

    let desc = `👑 → [${holderName}](${holderUrl}) — **${playsFormatted} plays**\n\n**${holderName}** holds the crown for ${artistLink} with ${playsFormatted} plays.`;

    if (challenger && challenger.userNameLastFm.toLowerCase() !== (currentCrown.userNameLastFm ?? '').toLowerCase()) {
      const diff = currentCrown.currentPlaycount - challenger.playcount;
      const diffStr =
        diff > 0
          ? `**${diff.toLocaleString()} plays** behind`
          : diff === 0
            ? 'tied with crown holder'
            : `**${Math.abs(diff).toLocaleString()} plays** ahead (run \`.wk\` to claim!)`;

      desc = `👑 → [${holderName}](${holderUrl}) — **${playsFormatted} plays**\n⚔️ → [${challenger.displayName}](${lastfmUserUrl(challenger.userNameLastFm)}) — **${challenger.playcount.toLocaleString()} plays**\n\n**${challenger.displayName}** is ${diffStr}.`;
    }

    const createdTs = Math.floor(new Date(currentCrown.created).getTime() / 1000);
    const modifiedTs = Math.floor(new Date(currentCrown.modified).getTime() / 1000);
    const holderMusicUrl = lastfmUserArtistUrl(currentCrown.userNameLastFm ?? holderName, artistName);

    const embed = new EmbedBuilder()
      .setTitle(`Crown for ${artistName}`)
      .setDescription(desc)
      .addFields({
        name: 'Current crown holder',
        value: `**<t:${createdTs}:D>** to **<t:${modifiedTs}:D>** — **[${holderName}](${holderMusicUrl})** — *${currentCrown.startPlaycount.toLocaleString()} to ${playsFormatted} plays*`,
        inline: false,
      });

    if (accentColor !== undefined && accentColor !== null) {
      embed.setColor(accentColor);
    }

    // Inactive history
    if (history && history.length > 1) {
      const past = history.filter((c) => !c.active).slice(0, 5);
      if (past.length > 0) {
        const historyLines = past.map((c) => {
          const from = Math.floor(new Date(c.created).getTime() / 1000);
          const to = Math.floor(new Date(c.modified).getTime() / 1000);
          const uUrl = lastfmUserArtistUrl(c.userNameLastFm ?? 'User', artistName);
          return `• <t:${from}:D> to <t:${to}:D> — **[${c.userNameLastFm ?? 'User'}](${uUrl})** — *${c.startPlaycount.toLocaleString()} to ${c.currentPlaycount.toLocaleString()} plays*`;
        });
        embed.addFields({
          name: 'Previous crown holders',
          value: historyLines.join('\n'),
          inline: false,
        });
      }
    }

    response.embed = embed;

    if (artistId) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`artist-whoknows:${artistId}`)
          .setLabel('WhoKnows')
          .setStyle(ButtonStyle.Secondary),
      );
      response.addButtonRow(0, row as any);
    }

    return response;
  }

  public static buildCrownLeaderboardResponse(
    guildName: string,
    items: CrownLeaderboardEntry[],
    callerUserId?: number,
    page: number = 1,
    totalActiveCrowns: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const pageSize = 10;
    const totalCount = items.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const clampedPage = Math.min(totalPages, Math.max(1, page));
    const startIdx = (clampedPage - 1) * pageSize;
    const pageItems = items.slice(startIdx, startIdx + pageSize);

    // 1. Header
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Users with most crowns in ${guildName}`),
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    // 2. Items
    if (pageItems.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('No active crowns in this server yet.'),
      );
    } else {
      const lines = pageItems.map((item, i) => {
        const rank = startIdx + i + 1;
        const playsWord = item.crownCount === 1 ? 'crown' : 'crowns';
        return `${rank}. **${item.displayName}** - *${item.crownCount.toLocaleString()} ${playsWord}*`;
      });

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n')),
      );
    }

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    // 3. User Ranking + Page info
    let callerRankStr = 'N/A';
    if (callerUserId) {
      const rankIdx = items.findIndex((it) => it.userId === callerUserId);
      if (rankIdx !== -1) {
        callerRankStr = `#${rankIdx + 1}`;
      }
    }

    const totalActive = totalActiveCrowns || items.reduce((sum, it) => sum + it.crownCount, 0);
    const footerText = `-# Your ranking: ${callerRankStr}\n-# Page ${clampedPage}/${totalPages} - ${totalActive.toLocaleString()} total active crowns in this server`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(footerText),
    );

    // 4. Select Menu for Leaderboards
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('guild-members')
      .setPlaceholder('Select member view')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([
        {
          label: 'Overview',
          value: 'Overview',
        },
        {
          label: 'Ordered by total crowns',
          value: 'Crowns',
          default: true,
        },
        {
          label: 'Ordered by recent listening time',
          value: 'ListeningTime',
        },
        {
          label: 'Ordered by total playcount (scrobbles)',
          value: 'Plays',
        },
      ]);

    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );

    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
