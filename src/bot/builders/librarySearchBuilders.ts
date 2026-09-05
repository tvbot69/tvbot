import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { SearchTab, SearchResultRow } from '@bot/services/librarySearchService';

export interface SearchPageOptions {
  query: string;
  tab: SearchTab;
  page: number;
  allRows: SearchResultRow[];
  cacheKey: string;
  targetDiscordUserId: string;
  accentColor?: number | null;
}

export class LibrarySearchBuilders {
  public static buildSearchResponse(options: SearchPageOptions): ResponseModel {
    const { query, tab, allRows, cacheKey, targetDiscordUserId, accentColor } = options;
    const res = new ResponseModel(accentColor ?? undefined);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const pageSize = tab === SearchTab.Plays ? 6 : 12;
    const totalMatches = allRows.length;

    let page = options.page;
    if (page < 0) page = 0;
    const maxPage = Math.max(0, Math.ceil(totalMatches / pageSize) - 1);
    if (page > maxPage) page = maxPage;

    const pageStart = page * pageSize;
    const pageRows = allRows.slice(pageStart, pageStart + pageSize);
    const hasNext = pageStart + pageSize < totalMatches;

    const tabNames: Record<SearchTab, string> = {
      [SearchTab.Tracks]: 'tracks',
      [SearchTab.Albums]: 'albums',
      [SearchTab.Artists]: 'artists',
      [SearchTab.Plays]: 'scrobbles',
    };
    const tabLabel = tabNames[tab];
    const matchWord = totalMatches === 1 ? 'match' : 'matches';

    const header = `### 🔎 Search results for '${query}'\n-# ${totalMatches.toLocaleString('en-US')} ${matchWord} in your cached ${tabLabel}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

    let body = '';
    if (pageRows.length === 0) {
      body = '*No matches found in your library.*';
    } else if (tab === SearchTab.Plays) {
      const playLines = pageRows.map((r) => {
        const artist = r.secondary ?? 'Unknown Artist';
        const trackUrl = `https://last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(r.primary)}`;
        const artistUrl = `https://last.fm/music/${encodeURIComponent(artist)}`;
        const unix = r.timePlayed ? Math.floor(r.timePlayed.getTime() / 1000) : 0;
        return `**[${r.primary}](${trackUrl})** by **[${artist}](${artistUrl})** <t:${unix}:R>`;
      });
      body = playLines.join('\n');
    } else {
      const lines = pageRows.map((r) => {
        const playsWord = r.count === 1 ? 'play' : 'plays';
        const countStr = `${r.count.toLocaleString('en-US')} ${playsWord}`;

        if (tab === SearchTab.Artists) {
          const artistUrl = `https://last.fm/music/${encodeURIComponent(r.primary)}`;
          return `**\`#${r.rank}\`**  **[${r.primary}](${artistUrl})** - *${countStr}*`;
        }

        if (tab === SearchTab.Albums) {
          const artist = r.secondary ?? '';
          const albumUrl = `https://last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(r.primary)}`;
          return `**\`#${r.rank}\`**  **${artist}** - **[${r.primary}](${albumUrl})** - *${countStr}*`;
        }

        // SearchTab.Tracks
        const artist = r.secondary ?? '';
        const trackUrl = `https://last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(r.primary)}`;
        return `**\`#${r.rank}\`**  **${artist}** - **[${r.primary}](${trackUrl})** - *${countStr}*`;
      });
      body = lines.join('\n');
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

    // Navigation Row (Prev, Next)
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`search:page:${cacheKey}:${tab}:${page - 1}:${targetDiscordUserId}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`search:page:${cacheKey}:${tab}:${page + 1}:${targetDiscordUserId}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasNext),
    );

    // Tab Row (Tracks, Albums, Artists, Plays)
    const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`search:tab:${cacheKey}:0:${targetDiscordUserId}`)
        .setLabel('Tracks')
        .setStyle(tab === SearchTab.Tracks ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab === SearchTab.Tracks),
      new ButtonBuilder()
        .setCustomId(`search:tab:${cacheKey}:1:${targetDiscordUserId}`)
        .setLabel('Albums')
        .setStyle(tab === SearchTab.Albums ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab === SearchTab.Albums),
      new ButtonBuilder()
        .setCustomId(`search:tab:${cacheKey}:2:${targetDiscordUserId}`)
        .setLabel('Artists')
        .setStyle(tab === SearchTab.Artists ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab === SearchTab.Artists),
      new ButtonBuilder()
        .setCustomId(`search:tab:${cacheKey}:3:${targetDiscordUserId}`)
        .setLabel('Plays')
        .setStyle(tab === SearchTab.Plays ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab === SearchTab.Plays),
    );

    container.addActionRowComponents(navRow, tabRow);

    res.setComponentsV2Container(container);
    res.addButtonRow(0, navRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);
    res.addButtonRow(1, tabRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

    // Classic embed fallback
    res.embed.setTitle(null);
    res.embed.setDescription(`${header}\n\n${body}`);

    return res;
  }
}
