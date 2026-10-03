import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { formatDuration, type MusicTrack } from '@domain/models/music/musicTrack';
import { ALL_FILTERS, type FilterName, type MusicQueueInfo } from '@domain/models/music/musicQueue';
import type { LavalinkNodeStats } from '@bot/services/music/moonlinkManager';
import type { VideoChapter } from '@bot/services/music/videoChapters';
import { escapeInline, escapeLinkLabel, escapeMarkdown } from '@domain/text/markdown';
import { pluralise } from '@bot/builders/common/pluralise';

export type FallbackRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

/**
 * Single choke point for legacy fallback rows.
 *
 * `ResponseModel.addButtonRow` takes `ActionRowBuilder<MessageActionRowComponentBuilder>`
 * while `ContainerBuilder.addActionRowComponents` accepts any narrow row, so a
 * `ActionRowBuilder<ButtonBuilder>` needed an `as unknown as` at every call
 * site (9 of them). Building the row directly at the wide type keeps ONE
 * instance serving both the V2 container and the fallback embed — a V2-only
 * edit can no longer drift from its fallback because there is no second row.
 */
export const fallbackRow = (...components: MessageActionRowComponentBuilder[]): FallbackRow =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);

export const MUSIC_SOURCE_BADGES = {
  spotify: '<:sp:1496297132381048995>',
  youtube: '<:yt:1496297072201040094>',
  soundcloud: '<:sound:1545234670239879282>',
} as const;

export const getSourceBadge = (source?: string): string => {
  if (!source) return MUSIC_SOURCE_BADGES.youtube;
  const s = source.toLowerCase();
  if (s === 'spotify') return MUSIC_SOURCE_BADGES.spotify;
  if (s === 'soundcloud') return MUSIC_SOURCE_BADGES.soundcloud;
  return MUSIC_SOURCE_BADGES.youtube;
};

export class MusicBuilders {
  /**
   * Static meta line for the Now Playing card: requester plus remaining
   * time ("4:08 mins left", "42 secs left" under a minute, "Live" for
   * streams). Deliberately position-derived-once: the card is event-driven,
   * never polled, so remaining is a snapshot that refreshes on pause,
   * resume, seeks and boundaries. Text-only, no emojis.
   */
  public static buildNowPlayingMetaLine(    durationMs: number,
    positionMs: number,
    isStream: boolean,
    requesterTag?: string,
  ): string {
    const bits: string[] = [];
    const tag = requesterTag?.trim();
    if (tag) bits.push(`Ordered by ${tag.slice(0, 32)}`);
    if (isStream || durationMs <= 0) {
      bits.push('Live');
    } else {
      const remainingMs = Math.max(0, durationMs - Math.max(0, positionMs));
      if (remainingMs >= 60000) {
        bits.push(`${formatDuration(remainingMs)} mins left`);
      } else {
        const secs = Math.max(1, Math.ceil(remainingMs / 1000));
        bits.push(`${secs} ${secs === 1 ? 'sec' : 'secs'} left`);
      }
    }
    return `-# ${bits.join(' • ')}`;
  }

  public static buildTrackAddedResponse(
    track: MusicTrack,
    position: number,
    totalQueueCount: number,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    const isNowPlaying = position === 1 && totalQueueCount === 1;
    const title = isNowPlaying ? '🎵 Now Playing' : '🎵 Added to Queue';
    const sourceBadge = getSourceBadge(track.source);

    // Backward-compatible fallback embed
    response.embed
      .setTitle(title)
      .setDescription(`[${track.title}](${track.uri})\n**Artist:** ${track.author} • ${sourceBadge}`)
      .addFields(
        { name: 'Duration', value: track.isStream ? '🔴 LIVE' : formatDuration(track.duration), inline: true },
        { name: 'Position', value: isNowPlaying ? 'Now' : `#${position}`, inline: true },
      );

    if (track.requester?.tag) {
      response.embed.addFields({
        name: 'Requested By',
        value: `<@${track.requester.id}>`,
        inline: true,
      });
    }

    if (track.artworkUrl) {
      response.embed.setThumbnail(track.artworkUrl);
    }

    // Modern Discord Components V2 Container
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }
    const header = isNowPlaying ? '-# 🎵 STARTING PLAYBACK' : '-# 📑 ADDED TO QUEUE';
    const mainContent = `### [${track.title}](${track.uri})\n**${track.author}** • ${sourceBadge} • \`${track.isStream ? 'LIVE' : formatDuration(track.duration)}\``;
    const footerText = isNowPlaying
      ? `Playing now${track.requester?.tag ? ` • Requested by ${track.requester.tag}` : ''}`
      : `Position: **#${position}**${track.requester?.tag ? ` • Requested by ${track.requester.tag}` : ''}`;

    if (track.artworkUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}\n-# ${footerText}`))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: track.artworkUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}\n-# ${footerText}`));
    }

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildPlaylistAddedResponse(
    name: string,
    count: number,
    totalDuration: number,
    artworkUrl?: string,
    position?: number,
    accentColor?: number,
    source?: string,
    partial: boolean = false,
    partialReason?: string,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    // Backward-compatible fallback embed
    response.embed
      .setTitle('📑 Playlist Added to Queue')
      .setDescription(`**${name}**`)
      .addFields(
        { name: 'Tracks Added', value: `${count}`, inline: true },
        { name: 'Total Duration', value: formatDuration(totalDuration), inline: true },
      );

    if (position && position > 1) {
      response.embed.addFields({
        name: 'Starting Position',
        value: `#${position}`,
        inline: true,
      });
    }

    if (artworkUrl) {
      response.embed.setThumbnail(artworkUrl);
    }

    // Modern Discord Components V2 Container
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }
    const header = `-# 📑 PLAYLIST ADDED TO QUEUE`;
    const sourceBadge = source ? ` • ${getSourceBadge(source)}` : '';
    const partialNote = partial
      ? `\n-# Partial load — ${partialReason ?? 'some tracks were unresolvable and skipped'}`
      : '';
    const mainContent = `### ${name}\n**${count} tracks** • \`${formatDuration(totalDuration)}\`${sourceBadge}${position && position > 1 ? ` • Starts at #${position}` : ''}${partialNote}`;

    if (artworkUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}`))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: artworkUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}`));
    }

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Builds the rich, modern interactive "Now Playing" controller card using Discord Components V2.
   * Single unified container: full-width hero media gallery on top, sleek divider,
   * minimalist metadata with live progress bar, and integrated playback controls.
   */
  /**
   * Karaoke section for the Now Playing card: the line being sung plus the
   * next line, compact and text-only. Returns null when nothing singable.
   * Long lines WRAP at word boundaries (never `...`): a cut lyric reads
   * like a wrong lyric, a wrapped one just continues on the next line.
   */
  public static buildLyricSection(
    lyricWindow?: { current: string | null; next: string | null } | null,
    v2: boolean = true,
  ): string | null {
    if (!lyricWindow || (lyricWindow.current === null && lyricWindow.next === null)) return null;
    // Single source for V2 + fallback: both read these wrapped strings.
    const current = lyricWindow.current ? MusicBuilders.wrapLyricLine(lyricWindow.current) : null;
    const next = lyricWindow.next ? MusicBuilders.wrapLyricLine(lyricWindow.next) : null;
    const head = current ? `**${current}**` : null;
    // A lone upcoming line stays italic (pre-first-line styling); beside a
    // current line the V2 next line is plain, the legacy one italic.
    const tail = next ? (v2 && head ? next : `*${next}*`) : null;
    if (head && tail) return `${head}\n${tail}`;
    return head ?? tail;
  };

  /**
   * Word-boundary wrap for lyric lines: chunks of at most
   * NOW_PLAYING_TEXT_LIMIT chars, at most two lines, no ellipsis. A single
   * word longer than the limit is hard-split. Anything past the second
   * line is dropped (LRC lines past 116 chars are vanishingly rare, and a
   * third line would push the card rather than the lyric).
   */
  private static wrapLyricLine(text: string): string {
    const max = MusicBuilders.NOW_PLAYING_TEXT_LIMIT;
    const maxLines = 2;
    const out: string[] = [];
    let line = '';
    const push = (l: string): void => {
      if (l && out.length < maxLines) out.push(l);
    };
    for (const rawWord of text.replace(/[\r\n]+/g, ' ').split(' ')) {
      let word = rawWord;
      if (!word) continue;
      while (word.length > max) {
        push(line);
        line = '';
        push(word.slice(0, max));
        word = word.slice(max);
      }
      if ((line + (line ? ' ' : '') + word).length > max) {
        push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    push(line);
    return out.join('\n');
  }

  /**
   * Card-text budget for the Now Playing card: 58 chars, then `...`.
   * Existing `clamp` is TOTAL (slice to max-3); this one keeps the full
   * budget and appends, so a 58-char line passes through untouched.
   * Applied AFTER trim/escape; a slice that lands on a lone `\` would
   * re-arm the next char, so trailing backslashes are stripped.
   */
  private static readonly NOW_PLAYING_TEXT_LIMIT = 58;

  private static clampDisplay(text: string, max: number = MusicBuilders.NOW_PLAYING_TEXT_LIMIT): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max).replace(/\\+$/, '')}...`;
  }

  /**
   * Display-only title trim for the Now Playing card: drops trailing
   * bracket junk ("[FULL SET | 9/13/26]", "[Official Video]") and
   * metadata-like parens ("(Official Video)", "(4K)"). Never touches
   * matching/search data — card rendering only.
   */
  private static trimDisplayTitle(title: string): string {
    let t = title.trim().replace(/(\s*\[[^\[\]]*\]\s*)+$/, '').trim();
    for (;;) {
      const m = /^(.*)\s*\(([^()]*)\)\s*$/.exec(t);
      if (!m) break;
      if (!/(official|video|audio|lyric|visualiz|remaster|explicit|\bhd\b|4k|full|premiere|\bmv\b|m\/v)/i.test(m[2] ?? '')) break;
      t = (m[1] ?? '').trim();
    }
    return t || title.trim();
  }

  public static buildNowPlayingResponse(
    queue: MusicQueueInfo,
    accentColor?: number,
    lyricWindow?: { current: string | null; next: string | null } | null,
    chapter?: { title: string; artworkUrl?: string | null } | null,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    if (!queue.current) {
      const container = new ContainerBuilder();
      if (color !== undefined && color !== null) {
        container.setAccentColor(color);
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🎵 Now Playing\n*Nothing is currently playing.*'),
      );
      response.setComponentsV2Container(container);
      response.embed
        .setTitle('🎵 Now Playing')
        .setDescription('*Nothing is currently playing.*');
      return response;
    }

    const current = queue.current;
    const sourceIcon = getSourceBadge(current.source);

    // One-line header: title • album (when known) • artist • source badge.
    // Then live-show chapter, lyrics, and a static remaining-time meta line.
    // No live position anywhere: the card is event-driven, never polled, so
    // every line must stay true without ticks. Text-only, no emojis. The
    // header is body-size on purpose — ### rendered oversized next to badges.
    // Titles/artists/albums are user-supplied, so they are escaped: a release
    // named "**FREE** [click](https://x)" used to restyle the whole card and
    // render a fake link.
    const displayTitle = MusicBuilders.clampDisplay(
      escapeLinkLabel(MusicBuilders.trimDisplayTitle(current.title)),
    );
    const headerParts = [`[${displayTitle}](${current.uri})`];
    if (current.album?.trim()) {
      const albumOneLine = escapeMarkdown(current.album.trim()).replace(/[\r\n]+/g, ' ');
      headerParts.push(MusicBuilders.clampDisplay(albumOneLine));
    }
    const artistOneLine = escapeMarkdown(current.author).replace(/[\r\n]+/g, ' ');
    headerParts.push(MusicBuilders.clampDisplay(artistOneLine), sourceIcon);
    const header = headerParts.join(' • ');
    const chapterLine = chapter ? `Live — **${escapeInline(chapter.title, 100)}**` : null;
    const lyricSection = MusicBuilders.buildLyricSection(lyricWindow, true);
    const legacyLyricSection = MusicBuilders.buildLyricSection(lyricWindow, false);
    const galleryUrl = chapter?.artworkUrl || current.artworkUrl;
    const metaLine = MusicBuilders.buildNowPlayingMetaLine(
      current.duration,
      queue.position,
      current.isStream,
      current.requester?.tag,
    );
    const legacyMeta = metaLine.replace(/^-# /, '');

    // Single Row of 5 Square Icon Playback Controls (Mobile-perfect, zero text squishing)
    const row0 = fallbackRow(
      new ButtonBuilder()
        .setCustomId('music:control:previous')
        .setLabel('⏮️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:pause_resume')
        .setLabel(queue.isPaused ? '▶️' : '⏸️')
        .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('music:control:skip')
        .setLabel('⏭️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:loop')
        .setLabel(queue.loopMode === 'track' ? '🔂' : '🔁')
        .setStyle(queue.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:stop')
        .setLabel('⏹️')
        .setStyle(ButtonStyle.Danger),
    );

    // Discord Components V2: Single unified card container
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }

    if (galleryUrl) {
      const gallery = new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(galleryUrl),
      );
      container.addMediaGalleryComponents(gallery);
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    if (chapterLine) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(chapterLine));
    }
    if (lyricSection) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
      );
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lyricSection));
    }
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false),
    );
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(metaLine));
    container.addActionRowComponents(row0);

    response.setComponentsV2Container(container);

    // Backward-compatible fallback embed & button row
    response.addButtonRow(0, row0);
    const legacyBody = chapterLine ? `${header}\n${chapterLine}` : header;
    const legacyDesc = legacyLyricSection ? `${legacyBody}\n\n${legacyLyricSection}` : legacyBody;
    response.embed.setDescription(`${legacyDesc}\n\n${legacyMeta}`);
    if (galleryUrl) {
      response.embed.setImage(galleryUrl);
    }

    return response;
  }

  /**
   * Builds the paginated queue display with interactive track removal dropdown.
   */
  public static buildQueueResponse(
    queue: MusicQueueInfo,
    page: number = 1,
    pageSize: number = 10,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    const totalTracks = queue.tracks.length;
    const totalPages = Math.max(1, Math.ceil(totalTracks / pageSize));
    // Math.max(1, NaN) is NaN, which produced an empty "Up Next" list, a
    // "Page NaN/3" footer and NaN inside every button customId. Sanitize at
    // the choke point so no caller can poison the card.
    const requested = Number.isFinite(page) ? Math.floor(page) : 1;
    const currentPage = Math.max(1, Math.min(requested > 0 ? requested : 1, totalPages));

    const startIndex = (currentPage - 1) * pageSize;
    const currentTracks = queue.tracks.slice(startIndex, startIndex + pageSize);

    let desc = '';

    if (queue.current) {
      const progressMs = queue.position;
      const totalMs = queue.current.duration;
      const progressStr = `${formatDuration(progressMs)} / ${queue.current.isStream ? 'LIVE' : formatDuration(totalMs)}`;
      desc += `**Now Playing:**\n[${queue.current.title}](${queue.current.uri}) — \`${queue.current.author}\`\n⏱️ ${progressStr}\n\n`;
    } else {
      desc += '*Nothing currently playing*\n\n';
    }

    if (currentTracks.length > 0) {
      desc += '**Up Next:**\n';
      currentTracks.forEach((track, idx) => {
        const itemNumber = startIndex + idx + 1;
        const reqStr = track.requester ? ` • <@${track.requester.id}>` : '';
        desc += `\`${itemNumber}.\` [${track.title}](${track.uri}) \`[${track.isStream ? 'LIVE' : formatDuration(track.duration)}]\`${reqStr}\n`;
      });
    } else if (queue.tracks.length === 0) {
      desc += '*Queue is empty. Use `/music play` or `+play` to add tracks.*';
    }

    response.embed
      .setTitle(`🎵 Music Queue (${totalTracks} track${totalTracks === 1 ? '' : 's'})`)
      .setDescription(desc)
      .setFooter({
        text: `Page ${currentPage}/${totalPages} • Remaining: ${formatDuration(queue.remainingDuration)} • Loop: ${queue.loopMode} • 24/7: ${queue.is247 ? 'On' : 'Off'}`,
      });

    // Row 0: Pagination Buttons
    if (totalPages > 1) {
      const row0 = fallbackRow(
        new ButtonBuilder()
          .setCustomId(`music:queue:first:${currentPage}`)
          .setLabel('⏮️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId(`music:queue:prev:${currentPage - 1}`)
          .setLabel('◀️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId(`music:queue:page:${currentPage}`)
          .setLabel(`${currentPage}/${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`music:queue:next:${currentPage + 1}`)
          .setLabel('▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage >= totalPages),
        new ButtonBuilder()
          .setCustomId(`music:queue:last:${totalPages}`)
          .setLabel('⏭️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages),
      );
      response.addButtonRow(0, row0);
    }

    // Row 1: Queue Actions
    const row1 = fallbackRow(
      new ButtonBuilder()
        .setCustomId('music:control:pause_resume')
        .setLabel(queue.isPaused ? '▶️ Resume' : '⏸️ Pause')
        .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:skip')
        .setLabel('⏭️ Skip')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!queue.current),
      new ButtonBuilder()
        .setCustomId('music:control:shuffle')
        .setLabel('🔀 Shuffle')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(queue.tracks.length < 2),
      new ButtonBuilder()
        .setCustomId('music:control:clear')
        .setLabel('🗑️ Clear')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(queue.tracks.length === 0),
      new ButtonBuilder()
        .setCustomId('music:control:view_nowplaying')
        .setLabel('🎵 Now Playing')
        .setStyle(ButtonStyle.Secondary),
    );
    response.addButtonRow(1, row1);

    // Row 2: Quick Remove Dropdown (if current page has tracks)
    if (currentTracks.length > 0) {
      const removeOptions = currentTracks.slice(0, 10).map((t, idx) => {
        const itemNumber = startIndex + idx + 1;
        const cleanTitle = t.title.length > 50 ? `${t.title.slice(0, 47)}...` : t.title;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${itemNumber}. ${cleanTitle}`)
          .setValue(String(itemNumber))
          .setDescription(`By ${t.author.slice(0, 40)} (${formatDuration(t.duration)})`)
          .setEmoji('🗑️');
      });

      const removeSelectRow = fallbackRow(
        new StringSelectMenuBuilder()
          .setCustomId('music:queue:quick_remove')
          .setPlaceholder('Select a track to remove from queue...')
          .addOptions(removeOptions),
      );
      response.addButtonRow(2, removeSelectRow);
    }

    return response;
  }

  /**
   * Builds the interactive Search Result menu with clickable dropdown.
   */
  /**
   * Clamp for user-supplied text embedded in a card. Discord's builders
   * package runs with validation ON, so `setTitle`/`setDescription` THROW
   * (they do not warn) when the limit is exceeded — a long search query or
   * track title turned into "Sorry, something went wrong".
   */
  private static clamp(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  }

  public static buildSearchResponse(
    query: string,
    tracks: MusicTrack[],
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    let desc = `Found **${tracks.length}** results for \`${MusicBuilders.clamp(query, 300)}\`:\n\n`;
    tracks.slice(0, 10).forEach((t, idx) => {
      desc += `\`${idx + 1}.\` **[${escapeLinkLabel(t.title)}](${t.uri})**\n`;
      desc += `   └ Artist: \`${t.author}\` • Duration: \`${formatDuration(t.duration)}\`\n`;
    });

    desc += '\n*Select a track from the dropdown below to play it:*';

    response.embed
      .setTitle(`🔍 Search Results: ${MusicBuilders.clamp(query, 200)}`)
      .setDescription(MusicBuilders.clamp(desc, 4000))
      .setFooter({ text: 'Select an option or click Cancel' });

    const options = tracks.slice(0, 10).map((t, idx) => {
      const cleanTitle = t.title.length > 50 ? `${t.title.slice(0, 47)}...` : t.title;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${idx + 1}. ${cleanTitle}`)
        .setValue(String(idx))
        .setDescription(`Artist: ${t.author.slice(0, 40)} | ${formatDuration(t.duration)}`)
        .setEmoji('🎵');
    });

    const selectRow = fallbackRow(
      new StringSelectMenuBuilder()
        .setCustomId('music:search:select')
        .setPlaceholder('Choose a track to play...')
        .addOptions(options),
    );
    response.addButtonRow(0, selectRow);

    const cancelRow = fallbackRow(
      new ButtonBuilder()
        .setCustomId('music:search:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    );
    response.addButtonRow(1, cancelRow);

    return response;
  }

  /**
   * Builds the interactive chapter list for live videos: full timestamped
   * list plus a dropdown that seeks the player to the chosen chapter.
   * Discord caps select menus at 25 options, so >25 chapters split across
   * two rows (50 selectable — descriptions never produce more).
   */
  private static readonly MAX_SELECTABLE_CHAPTERS = 50;

  public static buildChaptersResponse(
    track: Pick<MusicTrack, 'title' | 'author' | 'uri'>,
    chapters: VideoChapter[],
    currentIdx: number,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    const shown = chapters.slice(0, MusicBuilders.MAX_SELECTABLE_CHAPTERS);
    const hidden = chapters.length - shown.length;
    const listLines = shown.map((ch, idx) => {
      const stamp = formatDuration(ch.startMs);
      const title = (ch.title || 'Untitled').slice(0, 64);
      return idx === currentIdx
        ? `▶ **${title}** \`${stamp}\``
        : `\`${String(idx + 1).padStart(2, '0')}.\` \`${stamp}\` ${title}`;
    });
    // An empty chapter list produced `''`, and `setContent('')` throws, so a
    // chapter-less track lost the whole card. Every current caller checks
    // `length < 2` first; the fallback is here so the builder is safe on its own.
    const list = listLines.length > 0
      ? listLines.join('\n') + (hidden > 0 ? `\n-# …and ${hidden} more` : '')
      : '*No chapters were found for this track.*';

    const header = `### [${track.title}](${track.uri})\n-# ${track.author} • ${chapters.length} ${pluralise(chapters.length, 'chapter')}`;

    const rows: FallbackRow[] = [];
    for (let start = 0; start < shown.length; start += 25) {
      const options = shown.slice(start, start + 25).map((ch, offset) => {
        const idx = start + offset;
        const title = (ch.title || 'Untitled').slice(0, 90);
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${idx + 1}. ${title}`)
          .setValue(String(idx))
          .setDescription(`Starts at ${formatDuration(ch.startMs)}`)
          .setDefault(idx === currentIdx);
      });
      // Discord requires custom_id unique per MESSAGE, not per row — suffix
      // the chunk index so 26+ chapters (two rows) don't collide.
      rows.push(
        fallbackRow(
          new StringSelectMenuBuilder()
            .setCustomId(`music:chapters:seek:${start / 25}`)
            .setPlaceholder('Jump to a chapter...')
            .addOptions(options),
        ),
      );
    }

    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    );
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(list));
    for (const row of rows) {
      container.addActionRowComponents(row);
    }
    response.setComponentsV2Container(container);

    // Backward-compatible fallback embed
    response.embed
      .setTitle(track.title.slice(0, 200))
      .setDescription(`${header}\n\n${list}`.slice(0, 4000))
      .setFooter({ text: 'Pick a chapter from the menu to jump to it' });
    for (const row of rows) {
      response.addButtonRow(0, row);
    }

    return response;
  }

  /**
   * Builds the formatted lyrics embed.
   */
  public static buildLyricsResponse(
    title: string,
    artist: string,
    lyrics: string,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    response.embed
      .setTitle(`📜 Lyrics: ${title}`)
      .setDescription(`**Artist:** ${artist}\n\n${lyrics}`)
      .setFooter({ text: 'Powered by LRCLIB' });

    return response;
  }

  /** One-line effect per filter, shown in the panel and select menu. */
  private static readonly FILTER_DESCRIPTIONS: Record<FilterName, string> = {
    bassboost: 'Deep low-end lift',
    nightcore: 'Sped up and pitched',
    vaporwave: 'Slowed and pitched down',
    karaoke: 'Vocals removed',
    tremolo: 'Volume wobble',
    vibrato: 'Pitch wobble',
    rotation: '8D spinning pan',
    distortion: 'Gritty saturation',
    lowpass: 'Muffled highs',
    audiophile: 'Studio-grade clarity',
  };

  public static buildFiltersResponse(
    activeFilters: string[],
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(color);

    const lines = ALL_FILTERS.map((f: FilterName) => {
      const on = activeFilters.includes(f);
      const label = f.charAt(0).toUpperCase() + f.slice(1);
      return `${on ? '🟢' : '⚪'} **${label}** — ${MusicBuilders.FILTER_DESCRIPTIONS[f]}${on ? ' *(on)*' : ''}`;
    });
    const desc =
      activeFilters.length === 0
        ? 'Standard audio — nothing applied.\n\n'
        : `**${activeFilters.length} active:** ${activeFilters.map((f) => `\`${f}\``).join(', ')}\n\n`;

    response.embed
      .setTitle('🎛️ Audio Filters')
      .setDescription(desc + lines.join('\n'))
      .setFooter({ text: 'Pick from the menu to toggle • Reset clears everything' });

    const options = ALL_FILTERS.map((f: FilterName) => {
      const isEnabled = activeFilters.includes(f);
      return new StringSelectMenuOptionBuilder()
        .setLabel(f.charAt(0).toUpperCase() + f.slice(1))
        .setValue(f)
        .setDescription(`${MusicBuilders.FILTER_DESCRIPTIONS[f]} — ${isEnabled ? 'tap to turn off' : 'tap to turn on'}`)
        .setEmoji(isEnabled ? '🟢' : '⚪');
    });

    const selectRow = fallbackRow(
      new StringSelectMenuBuilder()
        .setCustomId('music:filter:select')
        .setPlaceholder('Toggle an audio filter...')
        .addOptions(options),
    );
    response.addButtonRow(0, selectRow);

    const resetRow = fallbackRow(
      new ButtonBuilder()
        .setCustomId('music:filter:reset')
        .setLabel('Reset All Filters')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(activeFilters.length === 0),
      new ButtonBuilder()
        .setCustomId('music:control:view_nowplaying')
        .setLabel('Back to Player')
        .setStyle(ButtonStyle.Secondary),
    );
    response.addButtonRow(1, resetRow);

    return response;
  }

  /**
   * Lavalink node status. `detailed` includes hosts, ports, CPU and memory —
   * infrastructure reconnaissance. Callers pass `detailed: false` for anyone
   * who is not a server admin, so an ordinary member cannot read the node
   * topology off the bot.
   */
  public static buildNodeStatsResponse(
    stats: LavalinkNodeStats[],
    accentColor?: number,
    detailed: boolean = true,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorBlue;
    const response = new ResponseModel(color);

    response.embed.setTitle('📊 Lavalink Nodes Status (Public Nodes Masterclass)');

    if (stats.length === 0) {
      response.embed.setDescription('No Lavalink nodes configured or connected.');
      return response;
    }

    let totalPlayers = 0;
    let totalPlaying = 0;
    let healthyNodes = 0;

    for (const node of stats) {
      totalPlayers += node.players;
      totalPlaying += node.playingPlayers;
      if (node.connected) healthyNodes++;
    }

    if (!detailed) {
      response.embed.setDescription(
        [
          `**Nodes:** ${healthyNodes}/${stats.length} healthy`,
          `**Active players:** ${totalPlayers} (${totalPlaying} playing)`,
          '',
          '*Run `/nodes` as a server admin for per-node diagnostics.*',
        ].join('\n'),
      );
      return response;
    }

    for (const node of stats) {
      const statusIcon = node.connected ? '🟢 Connected' : '🔴 Disconnected';
      const value = [
        `**Status:** ${statusIcon}`,
        `**Players:** ${node.players} (${node.playingPlayers} playing)`,
        `**CPU Load:** System ${node.cpuLoad}% | Lavalink ${node.lavalinkLoad}%`,
        `**Memory:** ${node.memoryUsedMb}MB / ${node.memoryAllocatedMb}MB`,
        `**Uptime:** ${Math.floor(node.uptimeMs / 1000 / 60)} min`,
      ].join('\n');

      // addFields asserts a 25-field total and a 256-char name.
      if ((response.embed.data.fields?.length ?? 0) >= 24) break;
      response.embed.addFields({
        name: `Node: ${node.identifier} (${node.host}:${node.port})`.slice(0, 256),
        value: value.slice(0, 1024),
        inline: false,
      });
    }

    response.embed.setFooter({
      text: `Healthy Nodes: ${healthyNodes}/${stats.length} • Total Players: ${totalPlayers} (${totalPlaying} playing)`,
    });

    return response;
  }

  public static buildSimpleResponse(
    title: string,
    description?: string,
    color?: number,
  ): ResponseModel {
    const finalColor = color ?? DiscordConstants.LastFmColorRed;
    const response = new ResponseModel(finalColor);
    // `EmbedBuilder.setTitle('')` and `TextDisplayBuilder.setContent('')` both
    // throw, so an empty title is an unsendable card rather than a blank one.
    const safeTitle = title || 'Notice';
    response.embed.setTitle(safeTitle);
    if (description) {
      response.embed.setDescription(description);
    }

    const container = new ContainerBuilder();
    container.setAccentColor(finalColor);
    const content = description ? `### ${safeTitle}\n${description}` : `### ${safeTitle}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    response.setComponentsV2Container(container);

    return response;
  }
}
