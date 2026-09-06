import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { YearOverviewData, GuildLeaderboardEntry } from '@bot/services/playHistoryService';

export const getOrdinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0] ?? 'th'}`;
};

export const getArtistUrl = (artist: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;

export const getAlbumUrl = (artist: string, album: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;

export const getTrackUrl = (artist: string, track: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

export class PlaycountBuilders {
  public static buildArtistPlaysResponse(
    userTitle: string,
    artistName: string,
    userPlaycount: number,
    weekPlays: number,
    monthPlays: number,
  ): ResponseModel {
    const playWord = userPlaycount === 1 ? 'play' : 'plays';
    let reply = `**${userTitle}** has **${userPlaycount}** ${playWord} for **${artistName}**`;

    if (monthPlays > 0) {
      const weekWord = weekPlays === 1 ? 'play' : 'plays';
      const monthWord = monthPlays === 1 ? 'play' : 'plays';
      reply += `\n-# *${weekPlays} ${weekWord} last week — ${monthPlays} ${monthWord} last month*`;
    }

    return new ResponseModel().setContent(reply);
  }

  public static buildAlbumPlaysResponse(
    userTitle: string,
    artistName: string,
    albumName: string,
    userPlaycount: number,
    weekPlays: number,
    monthPlays: number,
  ): ResponseModel {
    const playWord = userPlaycount === 1 ? 'play' : 'plays';
    let reply = `**${userTitle}** has **${userPlaycount}** ${playWord} for **${albumName}** by **${artistName}**`;

    if (monthPlays > 0) {
      const weekWord = weekPlays === 1 ? 'play' : 'plays';
      const monthWord = monthPlays === 1 ? 'play' : 'plays';
      reply += `\n-# *${weekPlays} ${weekWord} last week — ${monthPlays} ${monthWord} last month*`;
    }

    return new ResponseModel().setContent(reply);
  }

  public static buildTrackPlaysResponse(
    userTitle: string,
    artistName: string,
    trackName: string,
    userPlaycount: number,
    weekPlays: number,
    monthPlays: number,
  ): ResponseModel {
    const playWord = userPlaycount === 1 ? 'play' : 'plays';
    let reply = `**${userTitle}** has **${userPlaycount}** ${playWord} for **${trackName}** by **${artistName}**`;

    if (monthPlays > 0) {
      const weekWord = weekPlays === 1 ? 'play' : 'plays';
      const monthWord = monthPlays === 1 ? 'play' : 'plays';
      reply += `\n-# *${weekPlays} ${weekWord} last week — ${monthPlays} ${monthWord} last month*`;
    }

    return new ResponseModel().setContent(reply);
  }

  public static buildPlaysResponse(
    userTitle: string,
    count: number,
    isAllTime: boolean,
    periodDescription?: string,
  ): ResponseModel {
    const scrobbleWord = count === 1 ? 'scrobble' : 'scrobbles';
    const reply = isAllTime
      ? `**${userTitle}** has \`${count}\` total ${scrobbleWord}`
      : `**${userTitle}** has \`${count}\` ${scrobbleWord} in the ${periodDescription ?? 'selected period'}`;

    return new ResponseModel().setContent(reply);
  }

  public static buildPaceResponse(
    authorMention: string,
    targetDisplayName: string,
    isDifferentUser: boolean,
    goalAmount: number,
    userTotalPlaycount: number,
    countInPeriod: number,
    fromTimestamp: number,
    isAllTime: boolean,
  ): ResponseModel {
    const fromDate = new Date(fromTimestamp * 1000);
    const totalDays = Math.max(0.1, (Date.now() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    const playsLeft = goalAmount - userTotalPlaycount;
    const avgPerDay = countInPeriod / totalDays;
    const daysUntilGoal = playsLeft > 0 && avgPerDay > 0 ? playsLeft / avgPerDay : 0;
    const goalDate = new Date(Date.now() + daysUntilGoal * 24 * 60 * 60 * 1000);
    const goalDateUnix = Math.floor(goalDate.getTime() / 1000);

    let reply = isDifferentUser
      ? `${authorMention} My estimate is that the user '${targetDisplayName}' will reach **${goalAmount.toLocaleString('en-US')}** scrobbles on **<t:${goalDateUnix}:D>**.`
      : `${authorMention} My estimate is that you will reach **${goalAmount.toLocaleString('en-US')}** scrobbles on **<t:${goalDateUnix}:D>**.`;

    const avgStr = (Math.round(avgPerDay * 10) / 10).toLocaleString('en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const daysRounded = Math.round(totalDays);
    const dayWord = daysRounded === 1 ? 'day' : 'days';

    if (isAllTime) {
      const basedLine = isDifferentUser
        ? `-# *Based on their alltime average of ${avgStr} scrobbles per day — ${countInPeriod.toLocaleString('en-US')} total in ${daysRounded} ${dayWord}*`
        : `-# *Based on your alltime average of ${avgStr} scrobbles per day — ${countInPeriod.toLocaleString('en-US')} total in ${daysRounded} ${dayWord}*`;
      reply += `\n${basedLine}`;
    } else {
      const basedLine = isDifferentUser
        ? `-# *Based on their average of ${avgStr} scrobbles per day in the last ${daysRounded} ${dayWord} — ${countInPeriod.toLocaleString('en-US')} total*`
        : `-# *Based on your average of ${avgStr} scrobbles per day in the last ${daysRounded} ${dayWord} — ${countInPeriod.toLocaleString('en-US')} total*`;
      reply += `\n${basedLine}`;
    }

    return new ResponseModel().setContent(reply);
  }

  public static buildMilestoneResponse(
    userDisplayName: string,
    lastFmUsername: string,
    milestoneAmount: number,
    artistName: string,
    albumName: string | null | undefined,
    trackName: string,
    timePlayed?: Date | null,
    albumCoverUrl?: string | null,
    accentColor?: number | null,
    isRandom: boolean = false,
    targetUserId?: number,
    callerUserId?: number,
  ): ResponseModel {
    const res = new ResponseModel(accentColor ?? undefined);
    const ordinal = getOrdinal(milestoneAmount);

    res.embed.setTitle(`${ordinal} scrobble from ${userDisplayName}`);

    const trackLink = `[${trackName}](${getTrackUrl(artistName, trackName)})`;
    let desc = `### ${trackLink}\n**${artistName}**`;
    if (albumName && albumName.trim().length > 0) {
      desc += ` • *${albumName}*`;
    }

    if (timePlayed) {
      const unixTime = Math.floor(timePlayed.getTime() / 1000);
      desc += `\n\nDate played: **<t:${unixTime}:D>**`;

      const year = timePlayed.getUTCFullYear();
      const month = String(timePlayed.getUTCMonth() + 1).padStart(2, '0');
      const day = String(timePlayed.getUTCDate()).padStart(2, '0');
      const dateString = `${year}-${month}-${day}`;
      res.embed.setURL(`https://last.fm/user/${encodeURIComponent(lastFmUsername)}/library?from=${dateString}&to=${dateString}`);
    }

    res.embed.setDescription(desc);

    if (albumCoverUrl) {
      res.embed.setThumbnail(albumCoverUrl);
    }

    if (isRandom && targetUserId && callerUserId) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`milestone:reroll:${targetUserId}:${callerUserId}`)
          .setLabel('Reroll')
          .setEmoji('🎲')
          .setStyle(ButtonStyle.Secondary),
      );
      res.addButtonRow(0, row);
    }

    return res;
  }

  public static buildDiscoveryDateResponse(
    displayName: string,
    isDifferentUser: boolean,
    artistName: string,
    albumName: string | null | undefined,
    trackName: string,
    artistFirstPlayDate: Date | null,
    albumFirstPlayDate: Date | null,
    trackFirstPlayDate: Date | null,
    hasSearchValue: boolean,
    accentColor?: number | null,
  ): ResponseModel {
    const res = new ResponseModel(accentColor ?? undefined);

    const noResult = hasSearchValue ? 'No plays yet' : 'Just now';

    res.embed.setAuthor({ name: `Discovery dates for ${displayName}` });

    let desc = '';
    const artistUnix = artistFirstPlayDate ? Math.floor(artistFirstPlayDate.getTime() / 1000) : null;
    desc += `**${artistUnix ? `<t:${artistUnix}:D>` : noResult}** — **[${artistName}](${getArtistUrl(artistName)})**\n`;

    if (albumName) {
      const albumUnix = albumFirstPlayDate ? Math.floor(albumFirstPlayDate.getTime() / 1000) : null;
      desc += `**${albumUnix ? `<t:${albumUnix}:D>` : noResult}** — **[${albumName}](${getAlbumUrl(artistName, albumName)})**\n`;
    }

    const trackUnix = trackFirstPlayDate ? Math.floor(trackFirstPlayDate.getTime() / 1000) : null;
    desc += `**${trackUnix ? `<t:${trackUnix}:D>` : noResult}** — **[${trackName}](${getTrackUrl(artistName, trackName)})**\n`;

    res.embed.setDescription(desc);

    if (isDifferentUser) {
      res.embed.setFooter({ text: `Date for ${displayName}` });
    }

    return res;
  }

  public static buildLastListenedDateResponse(
    displayName: string,
    isDifferentUser: boolean,
    artistName: string,
    albumName: string | null | undefined,
    trackName: string,
    artistLastPlayDate: Date | null,
    albumLastPlayDate: Date | null,
    trackLastPlayDate: Date | null,
    hasSearchValue: boolean,
    accentColor?: number | null,
  ): ResponseModel {
    const res = new ResponseModel(accentColor ?? undefined);

    const noResult = hasSearchValue ? 'No plays yet' : 'First time';

    res.embed.setAuthor({ name: `Last listened dates for ${displayName}` });

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    let desc = '';
    if (artistLastPlayDate) {
      const unix = Math.floor(artistLastPlayDate.getTime() / 1000);
      const style = artistLastPlayDate.getTime() >= thirtyDaysAgo ? 'f' : 'D';
      desc += `**<t:${unix}:${style}>** — **[${artistName}](${getArtistUrl(artistName)})**\n`;
    } else {
      desc += `**${noResult}** — **[${artistName}](${getArtistUrl(artistName)})**\n`;
    }

    if (albumName) {
      if (albumLastPlayDate) {
        const unix = Math.floor(albumLastPlayDate.getTime() / 1000);
        const style = albumLastPlayDate.getTime() >= thirtyDaysAgo ? 'f' : 'D';
        desc += `**<t:${unix}:${style}>** — **[${albumName}](${getAlbumUrl(artistName, albumName)})**\n`;
      } else {
        desc += `**${noResult}** — **[${albumName}](${getAlbumUrl(artistName, albumName)})**\n`;
      }
    }

    if (trackLastPlayDate) {
      const unix = Math.floor(trackLastPlayDate.getTime() / 1000);
      const style = trackLastPlayDate.getTime() >= thirtyDaysAgo ? 'f' : 'D';
      desc += `**<t:${unix}:${style}>** — **[${trackName}](${getTrackUrl(artistName, trackName)})**\n`;
    } else {
      desc += `**${noResult}** — **[${trackName}](${getTrackUrl(artistName, trackName)})**\n`;
    }

    res.embed.setDescription(desc);

    if (isDifferentUser) {
      res.embed.setFooter({ text: `Date for ${displayName}` });
    }

    return res;
  }

  public static buildArtistPaceResponse(params: {
    callerMention: string;
    displayName: string;
    isDifferentUser: boolean;
    artistName: string;
    goalAmount: number;
    allTimePlays: number;
    periodPlays: number;
    days: number;
    accentColor?: number | null;
  }): ResponseModel {
    const res = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    res.commandResponse = CommandResponse.Ok;
    const avgPerDay = params.days > 0 ? params.periodPlays / params.days : 0;
    const playsLeft = params.goalAmount - params.allTimePlays;

    let content = '';
    const determiner = params.isDifferentUser ? 'their' : 'your';

    if (playsLeft <= 0) {
      content = `${params.callerMention} ${params.isDifferentUser ? `**${params.displayName}** has` : 'You have'} already reached **${params.goalAmount.toLocaleString()}** plays on **${params.artistName}**! 🎉 (Current: **${params.allTimePlays.toLocaleString()}**)`;
    } else if (avgPerDay <= 0) {
      content = `${params.callerMention} No plays found on **${params.artistName}** in the last ${params.days} days to estimate pace.`;
    } else {
      const daysToAdd = playsLeft / avgPerDay;
      const targetDate = new Date(Date.now() + daysToAdd * 86400 * 1000);
      const unix = Math.floor(targetDate.getTime() / 1000);

      const targetText = daysToAdd > 365 * 100
        ? 'on a date beyond the year 9999! 🚀'
        : `on **<t:${unix}:D>** (<t:${unix}:R>)`;

      content = `${params.callerMention} My estimate is that ${params.isDifferentUser ? `**${params.displayName}**` : 'you'} will reach **${params.goalAmount.toLocaleString()}** plays on **${params.artistName}** ${targetText}.\n\n-# *Based on ${determiner} average of **${avgPerDay.toFixed(1)}** plays/day in the last ${params.days} days (${params.periodPlays.toLocaleString()} in period · ${params.allTimePlays.toLocaleString()} all-time)*`;
    }

    return res.setContent(content);
  }

  public static buildYearOverviewResponse(params: {
    displayName: string;
    userNameLastFm: string;
    yearData: YearOverviewData;
    accentColor?: number | null;
  }): ResponseModel {
    const { displayName, userNameLastFm, yearData, accentColor } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}`;
    const header = `### 📅 ${yearData.year} Year in Review for [${displayName}](${userUrl})`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    let yoyDiff = '';
    if (yearData.previousTotalPlays && yearData.previousTotalPlays > 0) {
      const diff = yearData.totalPlays - yearData.previousTotalPlays;
      yoyDiff = ` (${diff >= 0 ? '📈 +' : '📉 -'}${Math.abs(diff).toLocaleString()} vs ${yearData.year - 1})`;
    }

    const summaryText =
      `🎧 **Total Plays:** ${yearData.totalPlays.toLocaleString()}${yoyDiff}\n` +
      `🎨 **Distinct Artists:** ${yearData.totalArtists.toLocaleString()}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(summaryText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (yearData.topArtists.length > 0) {
      let artistsText = '**Top Artists:**\n';
      yearData.topArtists.slice(0, 5).forEach((a, i) => {
        artistsText += `${i + 1}. **[${a.name}](${getArtistUrl(a.name)})** — *${a.playcount.toLocaleString()} plays*\n`;
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(artistsText.trim()));
    }

    if (yearData.topAlbums.length > 0) {
      let albumsText = '**Top Albums:**\n';
      yearData.topAlbums.slice(0, 5).forEach((al, i) => {
        albumsText += `${i + 1}. **[${al.albumName}](${getAlbumUrl(al.artistName, al.albumName)})** by ${al.artistName} — *${al.playcount.toLocaleString()} plays*\n`;
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(albumsText.trim()));
    }

    if (yearData.topTracks.length > 0) {
      let tracksText = '**Top Tracks:**\n';
      yearData.topTracks.slice(0, 5).forEach((t, i) => {
        tracksText += `${i + 1}. **[${t.trackName}](${getTrackUrl(t.artistName, t.trackName)})** by ${t.artistName} — *${t.playcount.toLocaleString()} plays*\n`;
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tracksText.trim()));
    }

    if (yearData.topGenres.length > 0 || yearData.topCountries.length > 0) {
      let metaText = '';
      if (yearData.topGenres.length > 0) {
        metaText += `🏷️ **Top Genres:** ${yearData.topGenres.slice(0, 5).map(g => g.name).join(', ')}\n`;
      }
      if (yearData.topCountries.length > 0) {
        metaText += `🌍 **Top Countries:** ${yearData.topCountries.slice(0, 5).map(c => `${c.countryName} (${c.playcount.toLocaleString()})`).join(', ')}`;
      }
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(metaText.trim()));
    }

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildRecapResponse(params: {
    displayName: string;
    userNameLastFm: string;
    yearData: YearOverviewData;
    accentColor?: number | null;
  }): ResponseModel {
    return PlaycountBuilders.buildYearOverviewResponse(params);
  }

  public static buildLeaderboardResponse(params: {
    guildName: string;
    title: string;
    unit: string;
    entries: GuildLeaderboardEntry[];
    pageIndex?: number;
    accentColor?: number | null;
  }): ResponseModel {
    const { guildName, title, unit, entries, pageIndex = 0, accentColor } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorRed);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🏆 ${title} for ${guildName}`),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (entries.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('No members found with plays in this server yet.'),
      );
    } else {
      const pageSize = 10;
      const start = pageIndex * pageSize;
      const pageEntries = entries.slice(start, start + pageSize);

      let listText = '';
      pageEntries.forEach((entry, idx) => {
        const rank = start + idx + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`;
        const display = entry.displayName || entry.userNameLastFm;
        listText += `${medal} [${display}](https://www.last.fm/user/${encodeURIComponent(entry.userNameLastFm)}) — **${entry.value.toLocaleString()}** ${unit}\n`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(listText.trim()));

      const totalPages = Math.ceil(entries.length / pageSize);
      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# Page ${pageIndex + 1} of ${totalPages} · ${entries.length} server members tracked`),
        );
      }
    }

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
