import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

export type HelpCategory =
  | 'home'
  | 'stats'
  | 'charts'
  | 'top'
  | 'whoknows'
  | 'music'
  | 'social'
  | 'settings';

export interface HelpCategoryMeta {
  id: HelpCategory;
  name: string;
  emoji: string;
  description: string;
}

export const HELP_CATEGORIES: HelpCategoryMeta[] = [
  {
    id: 'home',
    name: 'Overview & Quick Start',
    emoji: '🏠',
    description: 'Bot introduction, prefixes, and getting started',
  },
  {
    id: 'stats',
    name: 'Music Stats & Now Playing',
    emoji: '🎵',
    description: 'Scrobbles, live tracks, history, streaks, and library',
  },
  {
    id: 'charts',
    name: 'Charts & Collages',
    emoji: '📊',
    description: 'High-res album and artist grid collages (3x3, 5x5, 10x10)',
  },
  {
    id: 'top',
    name: 'Top Lists',
    emoji: '🏆',
    description: 'Top artists, albums, tracks with Image & Embed modes',
  },
  {
    id: 'whoknows',
    name: 'WhoKnows & Crowns',
    emoji: '👑',
    description: 'Guild listener rankings, crowns, and autoposts',
  },
  {
    id: 'music',
    name: 'Music Playback',
    emoji: '🎧',
    description: 'Lavalink audio streaming, queue, volume, and playback',
  },
  {
    id: 'social',
    name: 'Social, Games & Discovery',
    emoji: '🎮',
    description: 'Taste comparison, friends, trivia games, and genres',
  },
  {
    id: 'settings',
    name: 'Settings & Administration',
    emoji: '⚙️',
    description: 'Last.fm login, user customization, and guild admin',
  },
];

export class HelpBuilders {
  public static normalizeCategory(input?: string): HelpCategory {
    if (!input) return 'home';
    const clean = input.trim().toLowerCase();
    switch (clean) {
      case 'home':
      case 'main':
      case 'overview':
      case 'start':
        return 'home';
      case 'stats':
      case 'fm':
      case 'np':
      case 'recent':
      case 'play':
      case 'plays':
      case 'streak':
        return 'stats';
      case 'charts':
      case 'chart':
      case 'collage':
      case 'c':
        return 'charts';
      case 'top':
      case 'toplist':
      case 'toplists':
      case 'tar':
      case 'tab':
      case 'tt':
        return 'top';
      case 'whoknows':
      case 'wk':
      case 'wka':
      case 'wkt':
      case 'crown':
      case 'crowns':
      case 'server':
        return 'whoknows';
      case 'music':
      case 'audio':
      case 'lavalink':
      case 'voice':
      case 'player':
        return 'music';
      case 'social':
      case 'taste':
      case 'friends':
      case 'game':
      case 'games':
      case 'genre':
      case 'discovery':
        return 'social';
      case 'settings':
      case 'setting':
      case 'config':
      case 'admin':
      case 'login':
      case 'import':
        return 'settings';
      default:
        return 'home';
    }
  }

  public static buildHelpResponse(
    category: HelpCategory = 'home',
    prefix: string = '.',
    userId?: string,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorBlue;
    const response = new ResponseModel(color);
    response.commandResponse = CommandResponse.Ok;

    const embed = new EmbedBuilder().setColor(color);
    const safeUser = userId ? encodeURIComponent(userId) : 'all';

    // Embed Content based on category
    switch (category) {
      case 'home': {
        embed.setTitle('tvbot Documentation — Overview & Quick Start');
        embed.setDescription(
          `Welcome to **tvbot** — your private, full-featured music statistics and high-fidelity audio bot.\n\n` +
            `### 🚀 Quick Start Guide\n` +
            `1. **Link your Last.fm account**\n` +
            `   Run \`${prefix}login <username>\` or \`/login <username>\` to connect.\n` +
            `2. **Check your live music**\n` +
            `   Run \`${prefix}fm\` to view your now playing track with lyrics, love, and preview buttons.\n` +
            `3. **Generate your music chart**\n` +
            `   Run \`${prefix}c 3x3 w\` for your weekly 3x3 album collage.\n` +
            `4. **Compete with the server**\n` +
            `   Run \`${prefix}wk\` to see who listens to the current artist the most!\n\n` +
            `### 💡 Command Prefixes & Usage\n` +
            `• **Server Prefix**: \`${prefix}\` (e.g. \`${prefix}fm\`, \`${prefix}wk\`, \`${prefix}chart\`)\n` +
            `• **Alternative Prefix**: \`+\` is enabled in all channels (e.g. \`+fm\`, \`+tar\`, \`+wk\`)\n` +
            `• **Slash Commands**: All commands are also available as modern Discord \`/\` slash commands.\n` +
            `• **Mention**: You can also mention the bot: \`@tvbot command\`\n\n` +
            `*Use the drop-down menu below to explore detailed command categories!*`,
        );

        embed.addFields(
          {
            name: '⚡ Popular Shortcuts',
            value:
              `\`${prefix}fm\` • \`${prefix}recent\` • \`${prefix}c 3x3\` • \`${prefix}wk\` • \`${prefix}tar\` • \`${prefix}tab\` • \`${prefix}tt\` • \`${prefix}play\` • \`${prefix}settings\``,
          },
          {
            name: '🔗 Useful Links',
            value:
              `[Last.fm](https://www.last.fm) • [Spotify](https://open.spotify.com) • [Support Server](https://discord.gg)`,
          },
        );
        break;
      }

      case 'stats': {
        embed.setTitle('🎵 Music Stats & Now Playing');
        embed.setDescription(
          `Real-time Last.fm scrobble tracking, listening history, and personal milestones.\n\n` +
            `• **\`${prefix}fm\`** or **\`${prefix}np\`** \`[user]\`\n` +
            `  Show your currently scrobbling or last played track with cover art, user playcount, live scrobble button, lyrics, and Spotify preview.\n\n` +
            `• **\`${prefix}recent\`** or **\`${prefix}pr\`** \`[user]\`\n` +
            `  View your recent tracks history with interactive pagination.\n\n` +
            `• **\`${prefix}plays\`** or **\`${prefix}user\`** \`[user]\`\n` +
            `  User listening profile, scrobble count, and milestone tracking.\n\n` +
            `• **\`${prefix}streak\`** \`[user]\`\n` +
            `  View your active daily listening streak and personal records.\n\n` +
            `• **\`${prefix}milestone\`** \`[user]\`\n` +
            `  Track your progress toward the next major scrobble milestone (e.g. 10k, 50k).\n\n` +
            `• **\`${prefix}search\`** \`<query>\`\n` +
            `  Search your personal Last.fm library for songs, albums, or artists.\n\n` +
            `• **\`${prefix}artist\`** \`<artist>\`\n` +
            `  Artist overview: your playcount, global plays, top tracks, and albums.\n\n` +
            `• **\`${prefix}album\`** \`<artist> - <album>\`\n` +
            `  Album overview: tracklist, your plays per track, and artwork.\n\n` +
            `• **\`${prefix}track\`** \`<artist> - <track>\`\n` +
            `  Track details, your total plays, first scrobble date, and tags.`,
        );
        break;
      }

      case 'charts': {
        embed.setTitle('📊 Charts & Collages');
        embed.setDescription(
          `High-resolution album, artist, and track grid collages rendered via headless Chromium.\n\n` +
            `• **\`${prefix}chart\`** or **\`${prefix}c\`** \`[size] [period]\`\n` +
            `  Generate an album cover collage.\n` +
            `  *Example*: \`${prefix}c 3x3 w\` *(Weekly 3x3)*, \`${prefix}c 5x5 m\` *(Monthly 5x5)*, \`${prefix}c 10x10 y\`\n\n` +
            `• **\`${prefix}chartartist\`** or **\`${prefix}ca\`** \`[size] [period]\`\n` +
            `  Generate an artist collage using artist profile photos.\n\n` +
            `• **\`${prefix}charttrack\`** or **\`${prefix}ct\`** \`[size] [period]\`\n` +
            `  Generate a track collage using album cover art.\n\n` +
            `### 📐 Supported Sizes\n` +
            `\`3x3\` (9 items) • \`4x4\` (16 items) • \`5x5\` (25 items) • \`10x10\` (100 items)\n\n` +
            `### ⏱️ Time Periods\n` +
            `• \`w\` / \`weekly\` — Last 7 days\n` +
            `• \`m\` / \`monthly\` — Last 30 days\n` +
            `• \`3m\` — Last 90 days\n` +
            `• \`6m\` — Last 180 days\n` +
            `• \`y\` / \`yearly\` — Last 365 days\n` +
            `• \`o\` / \`overall\` — All-time listening history`,
        );
        break;
      }

      case 'top': {
        embed.setTitle('🏆 Top Lists');
        embed.setDescription(
          `Discover your most listened artists, albums, and songs across any timeframe.\n` +
            `*(Switch between Embed Mode and graphic Image Mode in \`${prefix}settings\`)*\n\n` +
            `• **\`${prefix}topartists\`** or **\`${prefix}tar\`** \`[period]\`\n` +
            `  Your top artists list with playcounts, ranks, and interactive pagination.\n\n` +
            `• **\`${prefix}topalbums\`** or **\`${prefix}tab\`** \`[period]\`\n` +
            `  Your top albums list with artwork showcase.\n\n` +
            `• **\`${prefix}toptracks\`** or **\`${prefix}tt\`** \`[period]\`\n` +
            `  Your top tracks list with playcount rankings.\n\n` +
            `• **\`${prefix}top\`** or **\`${prefix}to\`** \`[period]\`\n` +
            `  Combined overview of your #1 artists, albums, and tracks.\n\n` +
            `### 🖼️ Graphic Image Mode\n` +
            `In Image Mode (\`mode: 2\`), Top Lists generate stunning full-card infographics featuring:\n` +
            `• Period listening totals and average scrobbles\n` +
            `• Mini top 3 summary card\n` +
            `• Dynamic 10-tile album cover mosaic wallpaper`,
        );
        break;
      }

      case 'whoknows': {
        embed.setTitle('👑 WhoKnows & Crowns');
        embed.setDescription(
          `Compete with other server members for listening supremacy and crowns!\n\n` +
            `• **\`${prefix}whoknows\`** or **\`${prefix}wk\`** \`[artist]\`\n` +
            `  Server leaderboard for an artist. Shows listener rankings, playcounts, and crowns.\n\n` +
            `• **\`${prefix}whoknowsalbum\`** or **\`${prefix}wka\`** \`[album]\`\n` +
            `  Server leaderboard for an album with top tracks preview box.\n\n` +
            `• **\`${prefix}whoknowstrack\`** or **\`${prefix}wkt\`** \`[track]\`\n` +
            `  Server leaderboard for a specific song.\n\n` +
            `• **\`${prefix}server\`** or **\`${prefix}guild\`**\n` +
            `  Server-wide listening statistics, most scrobbled artists, and guild rank.\n\n` +
            `• **\`${prefix}crowns\`** or **\`${prefix}crown\`** \`[user]\`\n` +
            `  List all crowns currently held by you or another member in this server.\n\n` +
            `• **\`${prefix}stolen\`** \`[user]\`\n` +
            `  View recently stolen crowns between guild members.\n\n` +
            `• **\`${prefix}autopost\`** \`[subcommand]\`\n` +
            `  *(Admin)* Configure recurring scheduled leaderboard postings to server channels.`,
        );
        break;
      }

      case 'music': {
        embed.setTitle('🎧 Music Playback (Lavalink)');
        embed.setDescription(
          `Lossless, high-fidelity audio playback in voice channels powered by Moonlink and Lavalink.\n\n` +
            `• **\`${prefix}play\`** or **\`${prefix}p\`** \`<query | url>\`\n` +
            `  Search and stream audio from YouTube, Spotify, SoundCloud, or direct URLs.\n\n` +
            `• **\`${prefix}pause\`** & **\`${prefix}resume\`**\n` +
            `  Pause or resume audio playback.\n\n` +
            `• **\`${prefix}skip\`** or **\`${prefix}s\`** \`[amount]\`\n` +
            `  Skip current track or multiple tracks ahead in the queue.\n\n` +
            `• **\`${prefix}stop\`** or **\`${prefix}disconnect\`**\n` +
            `  Stop playback, clear the queue, and leave the voice channel.\n\n` +
            `• **\`${prefix}queue\`** or **\`${prefix}q\`** \`[page]\`\n` +
            `  Display upcoming tracks in the music queue.\n\n` +
            `• **\`${prefix}nowplaying\`** or **\`${prefix}m_np\`**\n` +
            `  Show currently playing audio track with dynamic progress bar and DSP analysis.\n\n` +
            `• **\`${prefix}volume\`** or **\`${prefix}vol\`** \`<0 - 150>\`\n` +
            `  Adjust output volume.\n\n` +
            `• **\`${prefix}shuffle\`**\n` +
            `  Randomize the track order of the current queue.\n\n` +
            `• **\`${prefix}loop\`** \`<off | track | queue>\`\n` +
            `  Toggle loop playback mode for the active track or entire queue.`,
        );
        break;
      }

      case 'social': {
        embed.setTitle('🎮 Social, Games & Discovery');
        embed.setDescription(
          `Music discovery, compatibility testing, and competitive trivia mini-games.\n\n` +
            `• **\`${prefix}taste\`** or **\`${prefix}compare\`** \`<@user | username>\`\n` +
            `  Compare your musical taste and shared artists with another member.\n\n` +
            `• **\`${prefix}exposed\`** or **\`${prefix}caughtin4k\`** \`[@user]\`\n` +
            `  Audit a member's listening history to expose secret guilty pleasures in 4K!\n\n` +
            `• **\`${prefix}friends\`** \`[user]\`\n` +
            `  View mutual friends, listening habits, and compatibility rankings.\n\n` +
            `• **\`${prefix}game\`** \`[track | artist | album]\`\n` +
            `  Launch a music trivia guesser game! Guess songs or artists from clues.\n\n` +
            `• **\`${prefix}genre\`** or **\`${prefix}tag\`** \`<genre>\`\n` +
            `  Explore top global artists and tracks for any genre or Last.fm tag.\n\n` +
            `• **\`${prefix}country\`** \`<country_name>\`\n` +
            `  Explore music listening charts and top artists across the globe.\n\n` +
            `• **\`${prefix}intelligence\`**\n` +
            `  Music puzzle challenges and title unscrambling.`,
        );
        break;
      }

      case 'settings': {
        embed.setTitle('⚙️ Settings, Admin & Import');
        embed.setDescription(
          `Account configuration, customization settings, and guild management.\n\n` +
            `• **\`${prefix}login\`** or **\`${prefix}set\`** \`<lastfm_username>\`\n` +
            `  Link your Last.fm username to your Discord account.\n\n` +
            `• **\`${prefix}settings\`**\n` +
            `  Interactive settings hub to customize:\n` +
            `  - **WK Mode**: Embed, Image, or Pagination (Components V2)\n` +
            `  - **Response Mode**: Embed or Image mode for Top lists\n` +
            `  - **Cover Cascade**: Spotify, Deezer, Apple Music, or Last.fm\n` +
            `  - **Privacy Mode**: Hide or display profile statistics\n\n` +
            `• **\`${prefix}prefix\`** \`<new_prefix>\`\n` +
            `  *(Server Admin)* Change the server's command prefix.\n\n` +
            `• **\`${prefix}disable\`** & **\`${prefix}enable\`** \`<command>\`\n` +
            `  *(Server Admin)* Disable or enable specific commands in channels.\n\n` +
            `• **\`${prefix}import\`**\n` +
            `  Import Spotify historical streaming history directly into your database.\n\n` +
            `• **\`${prefix}ping\`**\n` +
            `  Check bot websocket latency and response time.`,
        );
        break;
      }
    }

    embed.setFooter({
      text: `tvbot documentation • Category: ${HELP_CATEGORIES.find((c) => c.id === category)?.name ?? 'Overview'}`,
    });

    response.embed = embed;

    // Build Dropdown Select Menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`help:category:${safeUser}`)
      .setPlaceholder('Select a command category...')
      .setMinValues(1)
      .setMaxValues(1);

    for (const cat of HELP_CATEGORIES) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(cat.name)
          .setValue(cat.id)
          .setDescription(cat.description.slice(0, 100))
          .setEmoji(cat.emoji)
          .setDefault(cat.id === category),
      );
    }

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    response.addButtonRow(0, selectRow as any);

    // Build Quick Action Buttons Row
    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`help:btn:home:${safeUser}`)
        .setLabel('Home')
        .setEmoji('🏠')
        .setStyle(category === 'home' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(category === 'home'),
      new ButtonBuilder()
        .setCustomId(`help:btn:stats:${safeUser}`)
        .setLabel('Stats')
        .setEmoji('🎵')
        .setStyle(category === 'stats' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(category === 'stats'),
      new ButtonBuilder()
        .setCustomId(`help:btn:whoknows:${safeUser}`)
        .setLabel('WhoKnows')
        .setEmoji('👑')
        .setStyle(category === 'whoknows' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(category === 'whoknows'),
      new ButtonBuilder()
        .setCustomId(`help:btn:music:${safeUser}`)
        .setLabel('Music')
        .setEmoji('🎧')
        .setStyle(category === 'music' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(category === 'music'),
      new ButtonBuilder()
        .setCustomId(`help:btn:settings:${safeUser}`)
        .setLabel('Settings')
        .setEmoji('⚙️')
        .setStyle(category === 'settings' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(category === 'settings'),
    );

    response.addButtonRow(1, buttonRow as any);

    return response;
  }
}
