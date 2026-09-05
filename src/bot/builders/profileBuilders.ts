import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import type { LastFmUser } from '@domain/models/lastFmUser';
import type { User } from '@domain/interfaces/iuserRepository';
import { UserType } from '@persistence/domain/models/user';

export interface ProfileStats {
  userDisplayName: string;
  lastFmUser: LastFmUser;
  user?: User | null;
  differentTracksCount?: number;
  differentAlbumsCount?: number;
  differentArtistsCount?: number;
  top10ArtistsScrobbles?: number;
  friendsCount?: number;
  accentColor?: number | null;
}

export interface MonthHistoryEntry {
  monthName: string;
  playCount: number;
  timeString: string;
}

export interface YearHistoryEntry {
  year: string;
  playCount: number;
  timeString: string;
}

export interface ProfileHistoryStats {
  userDisplayName: string;
  lastFmUser: LastFmUser;
  registeredUnix: number;
  user?: User | null;
  accentColor?: number | null;
  months: MonthHistoryEntry[];
  years: YearHistoryEntry[];
}

export class ProfileBuilders {
  public static buildProfileResponse(stats: ProfileStats, callerDiscordUserId?: string): ResponseModel {
    const { userDisplayName, lastFmUser, user, accentColor } = stats;
    const res = new ResponseModel(accentColor ?? undefined);

    const userUrl = `https://last.fm/user/${encodeURIComponent(lastFmUser.name)}`;
    const playcount = lastFmUser.playCount.toLocaleString('en-US');
    const scrobbleWord = lastFmUser.playCount === 1 ? 'scrobble' : 'scrobbles';

    const registeredUnix = lastFmUser.registeredAt
      ? Math.floor(lastFmUser.registeredAt.getTime() / 1000)
      : 0;

    let initialDesc = `## [${userDisplayName}](${userUrl})\n`;
    initialDesc += `**${playcount}** ${scrobbleWord}\n`;
    if (registeredUnix > 0) {
      initialDesc += `Since <t:${registeredUnix}:D>\n`;
    }

    if (user && user.userType && user.userType !== UserType.User) {
      const typeStr = user.userType.toLowerCase();
      initialDesc += `⭐ tvbot ${typeStr}\n`;
    }

    // Variety section
    const trackCount = stats.differentTracksCount ?? lastFmUser.trackCount;
    const albumCount = stats.differentAlbumsCount ?? lastFmUser.albumCount;
    const artistCount = stats.differentArtistsCount ?? lastFmUser.artistCount;

    let varietyLines: string[] = [];
    if (trackCount && trackCount > 0) {
      varietyLines.push(`**${trackCount.toLocaleString('en-US')}** different tracks`);
    }
    if (albumCount && albumCount > 0) {
      varietyLines.push(`**${albumCount.toLocaleString('en-US')}** different albums`);
    }
    if (artistCount && artistCount > 0) {
      varietyLines.push(`**${artistCount.toLocaleString('en-US')}** different artists`);
    }

    // Averages and stats section
    let statLines: string[] = [];
    if (registeredUnix > 0 && lastFmUser.playCount > 0) {
      const days = Math.max(0.1, (Date.now() - registeredUnix * 1000) / (1000 * 86400));
      const avgPerDay = (Math.round((lastFmUser.playCount / days) * 10) / 10).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      statLines.push(`Average of **${avgPerDay}** scrobbles per day`);
    }

    if (artistCount && artistCount > 0) {
      if (albumCount && trackCount) {
        const albumsPerArtist = (Math.round((albumCount / artistCount) * 10) / 10).toFixed(1);
        const tracksPerArtist = (Math.round((trackCount / artistCount) * 10) / 10).toFixed(1);
        statLines.push(`Average of **${albumsPerArtist}** albums and **${tracksPerArtist}** tracks per artist`);
      }
    }

    if (stats.top10ArtistsScrobbles && stats.top10ArtistsScrobbles > 0 && lastFmUser.playCount > 0) {
      const percentage = (
        Math.round((stats.top10ArtistsScrobbles / lastFmUser.playCount) * 1000) / 10
      ).toFixed(1);
      statLines.push(`Top **10** artists make up **${percentage}%** of scrobbles`);
    }

    // ActionRow buttons: History & Last.fm link
    const targetDiscordId = user?.discordUserId ? user.discordUserId.toString() : '0';
    const callerId = callerDiscordUserId ?? targetDiscordId;
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`profile:history:${targetDiscordId}:${callerId}:${lastFmUser.name}`)
        .setLabel('History')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📖'),
      new ButtonBuilder()
        .setLabel('Last.fm')
        .setStyle(ButtonStyle.Link)
        .setURL(userUrl),
    );

    // ComponentsV2 layout
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }

    if (lastFmUser.imageUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(initialDesc.trim()))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: lastFmUser.imageUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(initialDesc.trim()));
    }

    if (varietyLines.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(varietyLines.join('\n')));
    }

    if (statLines.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statLines.join('\n')));
    }

    if (stats.friendsCount && stats.friendsCount > 0) {
      const friendWord = stats.friendsCount === 1 ? 'friend' : 'friends';
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${stats.friendsCount} ${friendWord}`));
    }

    container.addActionRowComponents(actionRow);

    res.setComponentsV2Container(container);
    res.addButtonRow(0, actionRow);

    // Classic embed fallback
    let fullEmbedDesc = initialDesc.trim();
    if (varietyLines.length > 0) {
      fullEmbedDesc += '\n\n' + varietyLines.join('\n');
    }
    if (statLines.length > 0) {
      fullEmbedDesc += '\n\n' + statLines.join('\n');
    }
    res.embed.setDescription(fullEmbedDesc);
    if (lastFmUser.imageUrl) {
      res.embed.setThumbnail(lastFmUser.imageUrl);
    }
    if (stats.friendsCount && stats.friendsCount > 0) {
      const friendWord = stats.friendsCount === 1 ? 'friend' : 'friends';
      res.embed.setFooter({ text: `${stats.friendsCount} ${friendWord}` });
    }

    return res;
  }

  public static buildProfileHistoryResponse(stats: ProfileHistoryStats, callerDiscordUserId?: string): ResponseModel {
    const { userDisplayName, lastFmUser, registeredUnix, user, accentColor, months, years } = stats;
    const res = new ResponseModel(accentColor ?? undefined);

    const userUrl = `https://last.fm/user/${encodeURIComponent(lastFmUser.name)}`;
    const playcount = lastFmUser.playCount.toLocaleString('en-US');
    const scrobbleWord = lastFmUser.playCount === 1 ? 'scrobble' : 'scrobbles';

    let initialDesc = `## [${userDisplayName}](${userUrl})'s history\n`;
    initialDesc += `**${playcount}** ${scrobbleWord}\n`;
    if (registeredUnix > 0) {
      initialDesc += `Since <t:${registeredUnix}:D>\n`;
    }

    // ActionRow buttons: Profile & Last.fm link
    const targetDiscordId = user?.discordUserId ? user.discordUserId.toString() : '0';
    const callerId = callerDiscordUserId ?? targetDiscordId;
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`profile:view:${targetDiscordId}:${callerId}:${lastFmUser.name}`)
        .setLabel('Profile')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('👤'),
      new ButtonBuilder()
        .setLabel('Last.fm')
        .setStyle(ButtonStyle.Link)
        .setURL(userUrl),
    );

    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }

    if (lastFmUser.imageUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(initialDesc.trim()))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: lastFmUser.imageUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(initialDesc.trim()));
    }

    let hasHistory = false;

    if (months.length > 0) {
      hasHistory = true;
      const monthLines = months.map(
        (m) => `**\`${m.monthName}\`** - **${m.playCount.toLocaleString('en-US')}** ${m.playCount === 1 ? 'play' : 'plays'} - **${m.timeString}**`,
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Last months**\n${monthLines.join('\n')}`));
    }

    if (years.length > 0) {
      hasHistory = true;
      const yearLines = years.map(
        (y) => `**\`${y.year}\`** - **${y.playCount.toLocaleString('en-US')}** ${y.playCount === 1 ? 'play' : 'plays'} - **${y.timeString}**`,
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**All years**\n${yearLines.join('\n')}`));
    }

    if (!hasHistory) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent('*Sorry, it seems like there is no stored data in tvbot for this user.*'));
    }

    container.addActionRowComponents(actionRow);

    res.setComponentsV2Container(container);
    res.addButtonRow(0, actionRow);

    // Classic embed fallback
    let fullEmbedDesc = initialDesc.trim();
    if (months.length > 0) {
      const monthLines = months.map(
        (m) => `**\`${m.monthName}\`** - **${m.playCount.toLocaleString('en-US')}** ${m.playCount === 1 ? 'play' : 'plays'} - **${m.timeString}**`,
      );
      fullEmbedDesc += `\n\n**Last months**\n${monthLines.join('\n')}`;
    }
    if (years.length > 0) {
      const yearLines = years.map(
        (y) => `**\`${y.year}\`** - **${y.playCount.toLocaleString('en-US')}** ${y.playCount === 1 ? 'play' : 'plays'} - **${y.timeString}**`,
      );
      fullEmbedDesc += `\n\n**All years**\n${yearLines.join('\n')}`;
    }
    res.embed.setDescription(fullEmbedDesc);
    if (lastFmUser.imageUrl) {
      res.embed.setThumbnail(lastFmUser.imageUrl);
    }

    return res;
  }
}
