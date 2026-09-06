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
import type { DiscogsReleaseItem, UserCollectionItem } from '@bot/services/discogsService';
import type { ImportSummary } from '@bot/services/importService';
import type { SpotifySearchTrack, SpotifySearchAlbum, SpotifySearchArtist } from '@spotify/models/spotifyModels';
import type { AppleMusicItem } from '@bot/services/appleMusicService';

export class DiscogsAndImportBuilders {
  public static buildDiscogsReleaseResponse(params: {
    release: DiscogsReleaseItem;
    accentColor?: number | null;
  }): ResponseModel {
    const { release } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorBlue);

    const titleText = `### 💿 Discogs: **${release.title}** by **${release.artist}**\n-# Detailed physical and digital release catalog data`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const sections = [
      `**💿 Format:** ${release.format.join(', ') || 'Vinyl, LP'}`,
      `**🏷️ Label:** ${release.label.join(', ') || 'Unknown'}`,
      `**📅 Released:** ${release.year || 'Unknown Year'} ${release.country ? `(${release.country})` : ''}`,
      `**🎵 Genre / Style:** ${[...release.genre, ...release.style].slice(0, 4).join(', ') || 'Music'}`,
    ];

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(sections.join('\n')));

    if (release.imageUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(release.imageUrl),
        ),
      );
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('View on Discogs')
        .setStyle(ButtonStyle.Link)
        .setURL(release.url),
    );

    container.addActionRowComponents(row);

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildCollectionResponse(params: {
    displayName: string;
    collection: UserCollectionItem[];
    prefix: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorBlue);

    const titleText = `### 📦 **${params.displayName}**'s Music Collection (${params.collection.length} releases)\n-# Physical and digital vinyl/CD collection`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.collection.length === 0) {
      const emptyMsg =
        `*Your collection is currently empty.*\n\n` +
        `**To add an album to your collection:**\n` +
        `> \`${params.prefix}collection add <artist> - <album> [format]\`\n` +
        `> Example: \`${params.prefix}collection add Radiohead - OK Computer Vinyl\`\n` +
        `> Example: \`${params.prefix}collection add Pink Floyd - The Dark Side of the Moon CD\`\n\n` +
        `**To remove an album:**\n` +
        `> \`${params.prefix}collection remove <number>\``;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(emptyMsg));
    } else {
      const lines = params.collection.map((item, idx) => {
        const icon =
          item.format === 'Vinyl' ? '💿' : item.format === 'CD' ? '💽' : item.format === 'Cassette' ? '📼' : '📁';
        return `${idx + 1}. ${icon} **${item.artist}** — *${item.album}* (\`${item.format}\`)`;
      });

      const body = `${lines.join('\n')}\n\n-# Add more with \`${params.prefix}collection add <artist> - <album> [format]\``;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildWhoHasResponse(params: {
    query: string;
    matches: Array<{ discordUserId: string; item: UserCollectionItem }>;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorBlue);

    const titleText = `### 🔍 Collection Ownership: **"${params.query}"**\n-# Server members with this release in their collection`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.matches.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`*No server members have added **"${params.query}"** to their collection yet.*`),
      );
    } else {
      const lines = params.matches.map((m, idx) => {
        const icon = m.item.format === 'Vinyl' ? '💿' : '💽';
        return `${idx + 1}. <@${m.discordUserId}> owns ${icon} **${m.item.artist}** — *${m.item.album}* (\`${m.item.format}\`)`;
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildImportInstructionsResponse(params: {
    instructions: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.SuccessColorGreen);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(params.instructions));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.SuccessColorGreen);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildImportSummaryResponse(params: {
    displayName: string;
    summary: ImportSummary;
    accentColor?: number | null;
  }): ResponseModel {
    const { summary } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.SuccessColorGreen);

    const titleText = `### ✅ Music History Successfully Imported for **${params.displayName}**!\n-# Zero-paywall streaming history ingestion complete`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const dateRangeStr = summary.dateRange
      ? `${summary.dateRange.from.toLocaleDateString()} ➔ ${summary.dateRange.to.toLocaleDateString()}`
      : 'All time';

    const topLines = summary.topArtists.map(
      (a, idx) => `${idx + 1}. **${a.name}** — **${a.count.toLocaleString()} plays**`,
    );

    const content =
      `• **${summary.totalScrobblesImported.toLocaleString()}** valid scrobbles added\n` +
      `• **${summary.uniqueArtistsCount.toLocaleString()}** unique artists\n` +
      `• **Date Range:** \`${dateRangeStr}\`\n\n` +
      `**Top Imported Artists:**\n${topLines.join('\n')}`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.SuccessColorGreen);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildImportModifyResponse(params: {
    success: boolean;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorBlue);

    const titleText = params.success
      ? '### 🔄 Import Reset\nSuccessfully cleared imported plays cache for your account.'
      : '### ⚠️ Import Modification Failed\nCould not modify import history at this time.';

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildSpotifyTrackResponse(params: {
    track: SpotifySearchTrack;
    accentColor?: number | null;
  }): ResponseModel {
    const { track } = params;
    const container = new ContainerBuilder();
    const spotifyColor = 0x1DB954;
    container.setAccentColor(params.accentColor ?? spotifyColor);

    const artistName = track.artists?.map((a) => a.name).join(', ') || 'Unknown Artist';
    const albumName = track.album?.name || 'Single / EP';
    const duration = track.duration_ms
      ? `${Math.floor(track.duration_ms / 60000)}:${String(Math.floor((track.duration_ms % 60000) / 1000)).padStart(2, '0')}`
      : 'Unknown duration';

    const titleText = `### 🟢 Spotify: **${track.name}**\n-# Track by **${artistName}** • *${albumName}*`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const details = [
      `**Artist:** ${artistName}`,
      `**Album:** ${albumName}`,
      `**Duration:** \`${duration}\`${track.explicit ? ' • 🔞 Explicit' : ''}`,
    ];
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join('\n')));

    const coverUrl = track.album?.images?.[0]?.url;
    if (coverUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(coverUrl)),
      );
    }

    const spotifyUrl = track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : null);
    if (spotifyUrl) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Play on Spotify').setStyle(ButtonStyle.Link).setURL(spotifyUrl),
      );
      container.addActionRowComponents(row);
    }

    const response = new ResponseModel(params.accentColor ?? spotifyColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildSpotifyAlbumResponse(params: {
    album: SpotifySearchAlbum;
    accentColor?: number | null;
  }): ResponseModel {
    const { album } = params;
    const container = new ContainerBuilder();
    const spotifyColor = 0x1DB954;
    container.setAccentColor(params.accentColor ?? spotifyColor);

    const artistName = album.artists?.map((a) => a.name).join(', ') || 'Unknown Artist';
    const titleText = `### 🟢 Spotify: **${album.name}**\n-# Album by **${artistName}**`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const details = [
      `**Artist:** ${artistName}`,
      `**Release Date:** ${album.release_date || 'Unknown'}`,
      `**Total Tracks:** ${album.total_tracks || 'N/A'}`,
    ];
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join('\n')));

    const coverUrl = album.images?.[0]?.url;
    if (coverUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(coverUrl)),
      );
    }

    const spotifyUrl = album.external_urls?.spotify || (album.id ? `https://open.spotify.com/album/${album.id}` : null);
    if (spotifyUrl) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Open in Spotify').setStyle(ButtonStyle.Link).setURL(spotifyUrl),
      );
      container.addActionRowComponents(row);
    }

    const response = new ResponseModel(params.accentColor ?? spotifyColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildSpotifyArtistResponse(params: {
    artist: SpotifySearchArtist;
    accentColor?: number | null;
  }): ResponseModel {
    const { artist } = params;
    const container = new ContainerBuilder();
    const spotifyColor = 0x1DB954;
    container.setAccentColor(params.accentColor ?? spotifyColor);

    const titleText = `### 🟢 Spotify: **${artist.name}**\n-# Verified Artist on Spotify`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const followers = artist.followers?.total ? artist.followers.total.toLocaleString() : 'N/A';
    const genres = artist.genres?.slice(0, 4).join(', ') || 'Various';
    const details = [
      `**Followers:** ${followers}`,
      `**Popularity:** ${artist.popularity ?? 0}%`,
      `**Genres:** ${genres}`,
    ];
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join('\n')));

    const imageUrl = artist.images?.[0]?.url;
    if (imageUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageUrl)),
      );
    }

    const spotifyUrl = artist.external_urls?.spotify || (artist.id ? `https://open.spotify.com/artist/${artist.id}` : null);
    if (spotifyUrl) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('View on Spotify').setStyle(ButtonStyle.Link).setURL(spotifyUrl),
      );
      container.addActionRowComponents(row);
    }

    const response = new ResponseModel(params.accentColor ?? spotifyColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAppleMusicResponse(params: {
    item: AppleMusicItem;
    accentColor?: number | null;
  }): ResponseModel {
    const { item } = params;
    const container = new ContainerBuilder();
    const appleColor = 0xFA2D48;
    container.setAccentColor(params.accentColor ?? appleColor);

    const titleText = `### 🍏 Apple Music: **${item.trackName}**\n-# By **${item.artistName}** ${item.albumName ? `• *${item.albumName}*` : ''}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const details = [
      `**Artist:** ${item.artistName}`,
      item.albumName ? `**Album:** ${item.albumName}` : null,
    ].filter(Boolean) as string[];
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join('\n')));

    if (item.artworkUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(item.artworkUrl)),
      );
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('Listen on Apple Music').setStyle(ButtonStyle.Link).setURL(item.url),
    );
    container.addActionRowComponents(row);

    const response = new ResponseModel(params.accentColor ?? appleColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}

