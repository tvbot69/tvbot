import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { JudgeResult } from '@bot/services/aiJudgeService';
import type { PlayingVoiceTrack } from '@bot/services/music/botScrobblingService';
import type { FeaturedEntry } from '@bot/services/featuredService';

export class UserHubBuilders {
  public static buildJudgeResponse(params: {
    result: JudgeResult;
    displayName: string;
    accentColor?: number | null;
  }): ResponseModel {
    const { result } = params;
    const container = new ContainerBuilder();

    let color = DiscordConstants.LastFmColorRed;
    let modeIcon = '⚖️';
    let modeTitle = 'Music Taste Evaluation';

    if (result.mode === 'roast') {
      color = 0xff7a01; // Orange
      modeIcon = '🔥';
      modeTitle = 'Music Taste Roast';
    } else if (result.mode === 'compliment') {
      color = 0xbaeda9; // Pastel Green
      modeIcon = '🙂';
      modeTitle = 'Music Taste Compliment';
    }

    container.setAccentColor(params.accentColor ?? color);

    const titleText = `### ${modeIcon} ${modeTitle} for **${params.displayName}** (\`${result.userNameLastFm}\`)\n-# Rating: **${result.rating}** — *${result.headline}*`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(result.critique));

    if (result.topArtists.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      const topStr = `-# 🎧 Key Artists Considered: ${result.topArtists.join(', ')}`;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(topStr));
    }

    // Action row to switch tones
    const buttonsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`userhub:judge:roast:${result.discordUserId}`)
        .setLabel('🔥 Roast')
        .setStyle(result.mode === 'roast' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`userhub:judge:compliment:${result.discordUserId}`)
        .setLabel('🙂 Compliment')
        .setStyle(result.mode === 'compliment' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`userhub:judge:judge:${result.discordUserId}`)
        .setLabel('⚖️ Verdict')
        .setStyle(result.mode === 'judge' ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    container.addActionRowComponents(buttonsRow);

    const response = new ResponseModel(params.accentColor ?? color);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildBotScrobblingResponse(params: {
    optedIn: boolean;
    nowPlaying?: PlayingVoiceTrack;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const statusText = params.optedIn
      ? '🟢 **Enabled** — Music played in voice channels will automatically scrobble to your Last.fm!'
      : '🔴 **Disabled** — Bot scrobbling is currently turned off.';

    const titleText = `### 📻 Bot Scrobbling\n-# Automatically scrobble music played by TVBot in voice channels to your Last.fm`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const explanation =
      `**Status:** ${statusText}\n\n` +
      `**How it works:**\n` +
      `> • Join any voice channel where TVBot is playing music\n` +
      `> • When a track plays past 50% or 4 minutes, TVBot will scrobble it directly to your Last.fm account\n` +
      `> • Requires your Last.fm account to be linked with \`.login\``;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(explanation));

    if (params.nowPlaying) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      const trackInfo = `🎶 **Currently Playing in Voice:** **${params.nowPlaying.title}** by **${params.nowPlaying.artist}**`;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(trackInfo));
    }

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('userhub:botscrobble:enable')
        .setLabel('Enable Scrobbling')
        .setStyle(ButtonStyle.Success)
        .setDisabled(params.optedIn),
      new ButtonBuilder()
        .setCustomId('userhub:botscrobble:disable')
        .setLabel('Disable Scrobbling')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!params.optedIn),
    );

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildBotTrackResponse(params: {
    track?: PlayingVoiceTrack;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    if (!params.track) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 📻 Bot Scrobbling\nNo music is currently playing in voice channels.'),
      );
    } else {
      const elapsedSec = Math.floor((Date.now() - params.track.startedAt) / 1000);
      const totalSec = Math.floor(params.track.durationMs / 1000);
      const content =
        `### 📻 Currently Scrobbled Voice Track\n` +
        `**Song:** **${params.track.title}**\n` +
        `**Artist:** **${params.track.artist}**\n` +
        `**Progress:** \`${elapsedSec}s / ${totalSec}s\`\n\n` +
        `*Listeners with bot scrobbling enabled in this voice channel will receive a scrobble.*`;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildFeaturedResponse(params: {
    featured: FeaturedEntry;
    prefix: string;
    accentColor?: number | null;
  }): ResponseModel {
    const { featured } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(featured.userNameLastFm)}`;
    const titleText = `### ⭐ Featured Community Listener\n-# Selected hourly from active community scrobblers`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const itemName = featured.albumName ? `Album: **${featured.albumName}**` : `Track: **${featured.trackName}**`;
    const details =
      `👤 User: <@${featured.discordUserId}> (**[${featured.userNameLastFm}](${userUrl})**)\n` +
      `🎤 Artist: **${featured.artistName}**\n` +
      `💿 ${itemName}\n` +
      `🔥 Weekly Scrobbles: **${featured.playcount.toLocaleString()} plays**\n\n` +
      `-# View previous featured users with \`${params.prefix}featuredlog\``;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details));

    if (featured.imageUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(featured.imageUrl),
        ),
      );
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildFeaturedLogResponse(params: {
    log: FeaturedEntry[];
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const titleText = `### 📜 Featured History Log (${params.log.length} entries)\n-# Recently featured active community listeners`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.log.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('*No featured users logged yet today.*'),
      );
    } else {
      const lines = params.log.map((entry, idx) => {
        const userUrl = `https://www.last.fm/user/${encodeURIComponent(entry.userNameLastFm)}`;
        const ts = Math.floor(entry.featuredAt.getTime() / 1000);
        const item = entry.albumName ?? entry.trackName ?? 'Top Release';
        return `${idx + 1}. <t:${ts}:R> — <@${entry.discordUserId}> (**[${entry.userNameLastFm}](${userUrl})**): **${entry.artistName}** - *${item}* (${entry.playcount} plays)`;
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildShortcutsResponse(params: {
    displayName: string;
    shortcuts: Array<{ name: string; command: string }>;
    prefix: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorBlue);

    const titleText = `### ⚡ Custom Shortcuts for **${params.displayName}**\n-# Personal command aliases and macros`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.shortcuts.length === 0) {
      const emptyHelp =
        `*You don't have any custom command shortcuts set up yet.*\n\n` +
        `**To create a shortcut:**\n` +
        `> \`${params.prefix}shortcut add <name> <command>\`\n` +
        `> Example: \`${params.prefix}shortcut add mytop top artists 1m\`\n` +
        `> Example: \`${params.prefix}shortcut add bestie fm @user\`\n\n` +
        `**To delete a shortcut:**\n` +
        `> \`${params.prefix}shortcut remove <name>\``;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(emptyHelp));
    } else {
      const lines = params.shortcuts.map(
        (sc) => `• \`${params.prefix}${sc.name}\` ➔ \`${params.prefix}${sc.command}\``,
      );
      const body = `**Your Shortcuts:**\n${lines.join('\n')}\n\n-# Add more with \`${params.prefix}shortcut add <name> <command>\``;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildRateYourMusicResponse(params: {
    query: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorBlue);

    const rymSearchUrl = `https://rateyourmusic.com/search?searchterm=${encodeURIComponent(params.query)}&searchtype=`;
    const content =
      `### 🎵 RateYourMusic Search\n` +
      `Looking up **${params.query}** on RateYourMusic. Click the button below to view ratings, reviews, and release catalogs!`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('Open on RateYourMusic')
        .setStyle(ButtonStyle.Link)
        .setURL(rymSearchUrl),
    );

    container.addActionRowComponents(row);

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildYoutubeResponse(params: {
    query: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? 0xff0000); // YouTube Red

    const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(params.query)}`;
    const content =
      `### 📺 YouTube Search\n` +
      `Searching YouTube for **${params.query}**.\n` +
      `Click below to watch the official audio or music video directly on YouTube.`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('Watch on YouTube')
        .setStyle(ButtonStyle.Link)
        .setURL(ytSearchUrl),
    );

    container.addActionRowComponents(row);

    const response = new ResponseModel(params.accentColor ?? 0xff0000);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
