import { EmbedBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { UpdateType } from '@domain/enums/updateType';

export class UpdateBuilders {
  public static buildDeltaInit(userNameLastFm: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    const embed = new EmbedBuilder()
      .setDescription(`⏳ Fetching recent scrobbles for **${userNameLastFm}**...`);
    if (accentColor !== undefined && accentColor !== null) {
      embed.setColor(accentColor);
    }
    response.embed = embed;
    return response;
  }

  public static buildDeltaResult(
    userNameLastFm: string,
    result: {
      newPlays: number;
      removedPlays: number;
      lastUpdate?: Date;
      latestScrobble?: Date;
    },
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.SuccessColorGreen;
    const response = new ResponseModel(color);
    const userUrl = `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}`;
    let description = '';

    if (result.newPlays === 0 && result.removedPlays === 0) {
      const nowUnix = Math.floor(Date.now() / 1000);
      description = `[${userNameLastFm}](${userUrl})'s playcounts were already up to date (last checked <t:${nowUnix}:R>).`;

      if (result.latestScrobble) {
        const scrobbleDate = result.latestScrobble instanceof Date
          ? result.latestScrobble
          : new Date(result.latestScrobble as unknown as string);
        if (!Number.isNaN(scrobbleDate.getTime())) {
          const scrobbleUnix = Math.floor(scrobbleDate.getTime() / 1000);
          description += `\n\nLast scrobble: <t:${scrobbleUnix}:R>`;
        }
      }
    } else {
      if (result.removedPlays === 0) {
        description = `[${userNameLastFm}](${userUrl})'s playcounts were updated with **${result.newPlays}** new ${result.newPlays === 1 ? 'scrobble' : 'scrobbles'}!`;
      } else {
        description = `[${userNameLastFm}](${userUrl})'s playcounts were updated with **${result.newPlays}** new ${result.newPlays === 1 ? 'scrobble' : 'scrobbles'} and **${result.removedPlays}** removed!`;
      }
    }

    response.embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(description);
    return response;
  }

  public static buildModularInit(userNameLastFm: string, updateType: UpdateType, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    const lines = [
      `⏳ Fetching playcounts for **${userNameLastFm}**...`,
      '',
      'Caches are being rebuilt:',
    ];

    if ((updateType & UpdateType.Full) === UpdateType.Full) {
      lines.push('- Full library update (Artists, Albums, Tracks & Scrobbles)');
    } else {
      if ((updateType & UpdateType.AllPlays) === UpdateType.AllPlays) lines.push('- All historical scrobbles');
      if ((updateType & UpdateType.Artists) === UpdateType.Artists) lines.push('- Top Artists');
      if ((updateType & UpdateType.Albums) === UpdateType.Albums) lines.push('- Top Albums');
      if ((updateType & UpdateType.Tracks) === UpdateType.Tracks) lines.push('- Top Tracks');
    }

    const embed = new EmbedBuilder()
      .setDescription(lines.join('\n'));
    if (accentColor !== undefined && accentColor !== null) {
      embed.setColor(accentColor);
    }
    response.embed = embed;
    return response;
  }

  public static buildModularResult(
    userNameLastFm: string,
    stats: {
      artistCount?: number;
      albumCount?: number;
      trackCount?: number;
      playCount?: number;
      totalScrobbles?: number;
      durationSec: string;
      error?: boolean;
    },
    accentColor?: number,
  ): ResponseModel {
    const defaultColor = stats.error ? DiscordConstants.WarningColorOrange : DiscordConstants.SuccessColorGreen;
    const color = accentColor ?? defaultColor;
    const response = new ResponseModel(color);
    const userUrl = `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}`;
    const lines = [
      `[${userNameLastFm}](${userUrl})'s data has been updated:`,
    ];

    if (stats.artistCount !== undefined) lines.push(`- **${stats.artistCount.toLocaleString()}** artists indexed`);
    if (stats.albumCount !== undefined) lines.push(`- **${stats.albumCount.toLocaleString()}** albums indexed`);
    if (stats.trackCount !== undefined) lines.push(`- **${stats.trackCount.toLocaleString()}** tracks indexed`);
    if (stats.playCount !== undefined) lines.push(`- **${stats.playCount.toLocaleString()}** plays stored`);
    if (stats.totalScrobbles !== undefined) lines.push(`- **${stats.totalScrobbles.toLocaleString()}** total scrobbles`);

    lines.push('', `*Completed in ${stats.durationSec}s*`);

    response.embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(lines.join('\n'));
    return response;
  }
}
