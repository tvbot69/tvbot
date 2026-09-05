import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import {
  type FootballDaySchedule,
  type FootballMatch,
  SUPPORTED_LEAGUES,
  getLeagueById,
} from '@domain/models/football/footballModels';

export const FOOTBALL_INTERACTION_PREFIX = 'fb:';

export class FootballBuilders {
  public static readonly PITCH_GREEN = 0x10b981; // Modern Emerald Sports Green

  /**
   * Builds the Components V2 Football Matches Dashboard
   */
  public static buildMatchesResponse(
    schedule: FootballDaySchedule,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? this.PITCH_GREEN;
    const response = new ResponseModel(color);

    const league = getLeagueById(schedule.leagueId);
    const dateLabel = this.formatDateLabel(schedule.date, schedule.dateOffset);
    const matchCount = schedule.matches.length;

    // Fallback embed for legacy Discord clients
    response.embed
      .setTitle(`${league.emoji} ${league.name} Matches`)
      .setDescription(`**Date:** ${dateLabel}\n**Total Matches:** ${matchCount}`)
      .setColor(color);

    const leagueLogo = schedule.leagueLogo || league.logo;
    if (leagueLogo) {
      response.embed.setThumbnail(leagueLogo);
    }

    if (matchCount > 0) {
      const sample = schedule.matches
        .slice(0, 10)
        .map((m) => this.formatMatchInline(m))
        .join('\n\n');
      response.embed.addFields({ name: 'Fixtures & Results', value: sample.slice(0, 1024) });
    } else {
      response.embed.addFields({
        name: 'No Matches',
        value: 'No matches scheduled for this date. Check tomorrow or select another league.',
      });
    }

    // Modern Discord Components V2 Container
    const container = new ContainerBuilder().setAccentColor(color);

    // 1. Header Section
    const liveCount = schedule.matches.filter((m) => m.status === 'LIVE' || m.status === 'HALFTIME').length;
    const liveBadge = liveCount > 0 ? ` • 🔴 \`${liveCount} LIVE\`` : '';
    const headerMarkdown = [
      `### ${league.emoji} ${league.name}`,
      `📅 **${dateLabel}** • \`${matchCount} match${matchCount === 1 ? '' : 'es'}\`${liveBadge}`,
    ].join('\n');

    if (leagueLogo) {
      const headerSection = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerMarkdown))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(leagueLogo));
      container.addSectionComponents(headerSection);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerMarkdown));
    }
    container.addSeparatorComponents(new SeparatorBuilder());

    // 2. Matches List Section
    if (matchCount === 0) {
      const emptyMarkdown = [
        '> ℹ️ **No matches scheduled on this date**',
        `> There are no fixtures listed for **${league.name}** on **${dateLabel}**.`,
        '> Use the navigation buttons below to check **Yesterday** or **Tomorrow**, or choose another league!',
      ].join('\n');

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(emptyMarkdown));
    } else {
      // Chunk matches into readable blocks
      const matchLines: string[] = [];
      for (const match of schedule.matches) {
        matchLines.push(this.formatMatchCard(match));
      }

      // Max Discord component text is 4000 characters, group nicely
      const content = matchLines.join('\n\n');
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.slice(0, 3900)));
    }

    container.addSeparatorComponents(new SeparatorBuilder());

    // 3. Date Navigation Row
    const prevLabel = schedule.dateOffset === 0 ? '◀ Yesterday' : '◀ Prev Day';
    const nextLabel = schedule.dateOffset === 0 ? 'Tomorrow ▶' : 'Next Day ▶';

    const dateRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${FOOTBALL_INTERACTION_PREFIX}prev:${league.id}:${schedule.dateOffset - 1}`)
        .setLabel(prevLabel)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${FOOTBALL_INTERACTION_PREFIX}today:${league.id}:0`)
        .setLabel('📅 Today')
        .setStyle(schedule.dateOffset === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(schedule.dateOffset === 0),
      new ButtonBuilder()
        .setCustomId(`${FOOTBALL_INTERACTION_PREFIX}next:${league.id}:${schedule.dateOffset + 1}`)
        .setLabel(nextLabel)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${FOOTBALL_INTERACTION_PREFIX}refresh:${league.id}:${schedule.dateOffset}`)
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Success),
    );

    // 4. League Selector Row (Dropdown)
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${FOOTBALL_INTERACTION_PREFIX}league:${schedule.dateOffset}`)
      .setPlaceholder(`🏆 Switch League (Current: ${league.name})`)
      .setMinValues(1)
      .setMaxValues(1);

    for (const l of SUPPORTED_LEAGUES) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(l.name)
          .setValue(l.id)
          .setEmoji(l.emoji)
          .setDescription(`${l.country} • ${l.shortName}`)
          .setDefault(l.id === league.id),
      );
    }

    const leagueRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    container.addActionRowComponents(dateRow);
    container.addActionRowComponents(leagueRow);

    response.setComponentsV2Container(container);
    return response;
  }

  private static formatMatchCard(m: FootballMatch): string {
    const homeBadge = m.homeTeam.badge ? `${m.homeTeam.badge} ` : '';
    const awayBadge = m.awayTeam.badge ? ` ${m.awayTeam.badge}` : '';
    const home = `${homeBadge}**${m.homeTeam.name}**`;
    const away = `**${m.awayTeam.name}**${awayBadge}`;

    if (m.status === 'LIVE' || m.status === 'HALFTIME') {
      const clock = m.status === 'HALFTIME' ? '⏸️ HT' : `🔴 LIVE ${m.statusDetail || ''}`.trim();
      const score = `**${m.homeTeam.score ?? 0} - ${m.awayTeam.score ?? 0}**`;
      return `> ${clock}\n> ${home}  ${score}  ${away}`;
    }

    if (m.status === 'FINISHED') {
      const score = `\`${m.homeTeam.score ?? 0} - ${m.awayTeam.score ?? 0}\``;
      const detail = m.statusDetail || 'FT';
      return `> 🏁 **${detail}** • ${home} ${score} ${away}`;
    }

    if (m.status === 'POSTPONED' || m.status === 'CANCELLED') {
      return `> ⚠️ **${m.statusDetail || 'Postponed'}** • ${home} vs ${away}`;
    }

    // SCHEDULED
    if (m.kickoffTimestamp) {
      const timeTag = `<t:${m.kickoffTimestamp}:t>`;
      const relTag = `<t:${m.kickoffTimestamp}:R>`;
      const venueStr = m.venue ? `\n> -# 🏟️ ${m.venue}` : '';
      return `> ⏰ ${timeTag} (${relTag})\n> ${home} vs ${away}${venueStr}`;
    }

    return `> ⏰ ${m.statusDetail || 'Scheduled'} • ${home} vs ${away}`;
  }

  private static formatMatchInline(m: FootballMatch): string {
    const homeBadge = m.homeTeam.badge ? `${m.homeTeam.badge} ` : '';
    const awayBadge = m.awayTeam.badge ? ` ${m.awayTeam.badge}` : '';
    const home = `${homeBadge}**${m.homeTeam.name}**`;
    const away = `**${m.awayTeam.name}**${awayBadge}`;
    if (m.status === 'LIVE' || m.status === 'HALFTIME') {
      return `🔴 ${home} ${m.homeTeam.score ?? 0} - ${m.awayTeam.score ?? 0} ${away} (${m.statusDetail || 'LIVE'})`;
    }
    if (m.status === 'FINISHED') {
      return `🏁 ${home} ${m.homeTeam.score ?? 0} - ${m.awayTeam.score ?? 0} ${away} (FT)`;
    }
    return `⏰ ${home} vs ${away} (${m.statusDetail || 'Scheduled'})`;
  }

  private static formatDateLabel(d: Date, offset: number): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];

    const dayName = days[d.getDay()];
    const dateNum = d.getDate();
    const monthName = months[d.getMonth()];
    const year = d.getFullYear();

    const formatted = `${dayName}, ${dateNum} ${monthName} ${year}`;
    if (offset === 0) return `Today (${formatted})`;
    if (offset === 1) return `Tomorrow (${formatted})`;
    if (offset === -1) return `Yesterday (${formatted})`;
    if (offset > 1) return `In +${offset} days (${formatted})`;
    return `${Math.abs(offset)} days ago (${formatted})`;
  }
}
