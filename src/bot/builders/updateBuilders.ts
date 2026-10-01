import { EmbedBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { toDate } from '@domain/date';

export class UpdateBuilders {
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
        const scrobbleDate = toDate(result.latestScrobble);
        if (scrobbleDate && !Number.isNaN(scrobbleDate.getTime())) {
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
