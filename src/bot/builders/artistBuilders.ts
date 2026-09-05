import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { MusicBrainzArtistData } from '@bot/services/musicBrainzService';

const lastfmArtistUrl = (artist: string) =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;
const lastfmAlbumUrl = (artist: string, album: string) =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;

function getCountryFlag(code?: string | null): string {
  if (!code || code.length !== 2) return '';
  const codePoints = code
    .toUpperCase()
    .split('')
    .map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function cleanBio(bio?: string): string {
  if (!bio) return '';
  let cleaned = bio.replace(/<[^>]*>/g, '').trim();
  const readMoreIdx = cleaned.indexOf('Read more on Last.fm');
  if (readMoreIdx !== -1) {
    cleaned = cleaned.slice(0, readMoreIdx).trim();
  }
  return cleaned;
}

export const ARTIST_SOCIAL_EMOJIS = {
  spotify: { id: '1496297132381048995', name: 'sp' },
  appleMusic: { id: '1496297174869479548', name: 'am' },
  deezer: { id: '1496297153717473311', name: 'dez' },
  bandcamp: { id: '1499324758364524595', name: 'bnd' },
  instagram: { id: '1499324552201633862', name: 'inst' },
  lastfm: { id: '1496297104434270290', name: 'las' },
  twitter: { id: '1499324577786892308', name: 'x_' },
  youtube: { id: '1496297072201040094', name: 'yt' },
  info: { id: '1183840696457777153', name: 'fmbot_info' },
};

export class ArtistBuilders {
  public static buildArtistOverviewResponse(
    artistName: string,
    artistId: number | string,
    displayName: string,
    targetUserId: string,
    authorUserId: string,
    totalArtistPlays: number,
    monthPlays: number,
    topTracks: Array<{ name: string; playcount: number }>,
    topAlbums: Array<{ name: string; playcount: number }>,
    genres: string[],
    imageUrl?: string | null,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    // 1) Header section (Section with Text & Thumbnail)
    const headerLines = [
      `## [${artistName}](${lastfmArtistUrl(artistName)})`,
      `Artist overview for **${displayName}**`,
      `**${totalArtistPlays}** ${totalArtistPlays === 1 ? 'play' : 'plays'}${monthPlays > 0 ? ` — **${monthPlays}** last month` : ''}`,
    ];

    if (imageUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: imageUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));
    }

    // 2) Top Tracks Section (up to 8)
    if (topTracks.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
      const trackLines = ['**Your top tracks**'];
      topTracks.slice(0, 8).forEach((t, i) => {
        trackLines.push(`\`${i + 1}\`  **${t.name}** - *${t.playcount}x*`);
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(trackLines.join('\n')));
    }

    // 3) Top Albums Section (up to 8)
    if (topAlbums.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
      const albumLines = ['**Your top albums**'];
      topAlbums.slice(0, 8).forEach((a, i) => {
        albumLines.push(`\`${i + 1}\`  **${a.name}** - *${a.playcount}x*`);
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(albumLines.join('\n')));
    }

    // 4) Genres line
    if (genres.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${genres.join(' - ')}`));
    }

    // 5) ActionRow Navigation Buttons
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`artist-info:${artistId}:${targetUserId}:${authorUserId}`)
        .setLabel('Artist')
        .setEmoji(ARTIST_SOCIAL_EMOJIS.info as any)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`artist-tracks:${artistId}:${targetUserId}:${authorUserId}:`)
        .setLabel('All tracks')
        .setEmoji({ name: '🎶' })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(topTracks.length === 0),
      new ButtonBuilder()
        .setCustomId(`artist-albums:${artistId}:${targetUserId}:${authorUserId}:`)
        .setLabel('All albums')
        .setEmoji({ name: '💽' })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(topAlbums.length === 0),
    );
    container.addActionRowComponents(navRow);

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistInfoResponse(
    artistName: string,
    artistId: number | string,
    displayName: string,
    targetUserId: string,
    authorUserId: string,
    mbData: MusicBrainzArtistData | null,
    bio: string,
    serverStats: { serverPlays: number; serverListeners: number },
    globalStats: { globalPlays: number; globalListeners: number },
    userStats: { userPlays: number; lastMonthPlays: number; userPercentage: number },
    genres: string[],
    imageUrl?: string | null,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    // 1) Header section (Section with Text & Thumbnail)
    const headerLines = [`## [${artistName}](${lastfmArtistUrl(artistName)})`];

    if (mbData?.location) {
      const flag = getCountryFlag(mbData.countryCode);
      headerLines.push(`Artist from **${mbData.location}** ${flag}`.trim());
    }
    if (mbData?.birthDate) {
      headerLines.push(`Born: <t:${mbData.birthDate}:D>`);
    }
    if (mbData?.type || mbData?.gender) {
      const subParts = [mbData.type, mbData.gender].filter(Boolean);
      headerLines.push(`-# ${subParts.join(' - ')}`);
    }

    if (imageUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: imageUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));
    }

    // 2) Bio section
    const cleaned = cleanBio(bio);
    if (cleaned) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cleaned));
    }

    // 3) Server & Global Stats section
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
    const statsLines: string[] = [];
    if (serverStats.serverPlays > 0) {
      statsLines.push(`**${serverStats.serverPlays}** plays in this server by **${serverStats.serverListeners}** ${serverStats.serverListeners === 1 ? 'listener' : 'listeners'}`);
    }
    statsLines.push(`**${globalStats.globalPlays.toLocaleString()}** Last.fm plays by **${globalStats.globalListeners.toLocaleString()}** listeners`);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statsLines.join('\n')));

    // 4) User Stats section
    if (userStats.userPlays > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
      const userLines = [
        `**${userStats.userPlays}** plays by **${displayName}**${userStats.lastMonthPlays > 0 ? ` — **${userStats.lastMonthPlays}** last month` : ''}`,
      ];
      if (userStats.userPercentage > 0) {
        userLines.push(`**${userStats.userPercentage.toFixed(2)} %** of all your plays`);
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(userLines.join('\n')));
    }

    // 5) Genres line
    if (genres.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${genres.join(' - ')}`));
    }

    // 6) Navigation Buttons Row
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`artist-overview:${artistId}:${targetUserId}:${authorUserId}`)
        .setLabel('Overview')
        .setEmoji({ name: '📊' })
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`artist-tracks:${artistId}:${targetUserId}:${authorUserId}:`)
        .setEmoji({ name: '🎶' })
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`artist-albums:${artistId}:${targetUserId}:${authorUserId}:`)
        .setEmoji({ name: '💽' })
        .setStyle(ButtonStyle.Secondary),
    );
    container.addActionRowComponents(navRow);

    // 7) Social Media Links Row
    const links = mbData?.links ?? {};
    const socialRow = new ActionRowBuilder<ButtonBuilder>();

    if (links.spotify) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.spotify).setEmoji(ARTIST_SOCIAL_EMOJIS.spotify as any));
    if (links.appleMusic) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.appleMusic).setEmoji(ARTIST_SOCIAL_EMOJIS.appleMusic as any));
    if (links.instagram) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.instagram).setEmoji(ARTIST_SOCIAL_EMOJIS.instagram as any));
    if (links.twitter) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.twitter).setEmoji(ARTIST_SOCIAL_EMOJIS.twitter as any));
    if (links.bandcamp && socialRow.components.length < 5) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.bandcamp).setEmoji(ARTIST_SOCIAL_EMOJIS.bandcamp as any));
    if (links.deezer && socialRow.components.length < 5) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.deezer).setEmoji(ARTIST_SOCIAL_EMOJIS.deezer as any));
    if (links.youtube && socialRow.components.length < 5) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.youtube).setEmoji(ARTIST_SOCIAL_EMOJIS.youtube as any));
    if (links.lastfm && socialRow.components.length < 5) socialRow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.lastfm).setEmoji(ARTIST_SOCIAL_EMOJIS.lastfm as any));

    if (socialRow.components.length > 0) {
      container.addActionRowComponents(socialRow);
    }

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistTopAlbumsResponse(
    artistName: string,
    artistId: number | string,
    displayName: string,
    targetUserId: string,
    authorUserId: string,
    albums: Array<{ name: string; playcount: number }>,
    totalArtistPlays: number,
    distinctCount: number,
    page: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(albums.length / perPage));
    const slice = albums.slice(page * perPage, (page + 1) * perPage);
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Your top albums for '${artistName}'`));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));

    const lines = slice.map((a, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **[${a.name}](${lastfmAlbumUrl(artistName, a.name)})** - *${a.playcount} ${a.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n') || 'No albums found.';

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));

    const footer = `-# Page ${page + 1}/${totalPages} — ${distinctCount} different albums\n-# ${displayName} has ${totalArtistPlays} total artist ${totalArtistPlays === 1 ? 'play' : 'plays'}\n-# Some albums outside of top 6000 might not be visible`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`aab:first:${page}:${artistId}:${targetUserId}:${authorUserId}`).setEmoji({ id: '883825508633182208', name: 'pages_first' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`aab:prev:${page}:${artistId}:${targetUserId}:${authorUserId}`).setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`aab:next:${page}:${artistId}:${targetUserId}:${authorUserId}`).setEmoji({ id: '883825508087922739', name: 'pages_next' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      new ButtonBuilder().setCustomId(`aab:last:${page}:${artistId}:${targetUserId}:${authorUserId}`).setEmoji({ id: '883825508482183258', name: 'pages_last' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      new ButtonBuilder().setCustomId(`artist-overview:${artistId}:${targetUserId}:${authorUserId}`).setEmoji({ name: '📊' } as any).setStyle(ButtonStyle.Secondary),
    );
    container.addActionRowComponents(row);

    response.setComponentsV2Container(container);
    return response;
  }
}
