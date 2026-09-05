import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { StreakModel, getEmojiForStreakCount } from '@bot/services/streakService';

export class StreakBuilders {
  public static buildStreakResponse(
    displayName: string,
    userNameLastFm: string,
    streak: StreakModel | null,
    accentColor?: number | null,
  ): ResponseModel {
    const res = new ResponseModel(accentColor ?? undefined);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const userUrl = `https://last.fm/user/${encodeURIComponent(userNameLastFm)}`;
    const headerTitle = `### Streak overview for [${displayName}](${userUrl}/library)`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerTitle));

    const hasStreak = streak && (streak.artistPlaycount > 1 || streak.albumPlaycount > 1 || streak.trackPlaycount > 1);

    if (hasStreak && streak) {
      const musicLines: string[] = [];

      // Artist line
      const artistUrl = `https://last.fm/music/${encodeURIComponent(streak.artistName)}`;
      const artistEmoji = streak.emoji ? `${streak.emoji} ` : '';
      const artistPlayWord = streak.artistPlaycount === 1 ? 'play' : 'plays';
      musicLines.push(
        `\`Artist:\` **[${streak.artistName}](${artistUrl})** - ${artistEmoji}**${streak.artistPlaycount}** ${artistPlayWord}`,
      );

      // Album line
      if (streak.albumPlaycount > 1 && streak.albumName) {
        const albumUrl = `https://last.fm/music/${encodeURIComponent(streak.artistName)}/${encodeURIComponent(streak.albumName)}`;
        const albumEmoji = getEmojiForStreakCount(streak.albumPlaycount);
        const albumEmojiPrefix = albumEmoji ? `${albumEmoji} ` : '';
        const albumPlayWord = streak.albumPlaycount === 1 ? 'play' : 'plays';
        musicLines.push(
          `\` Album:\` **[${streak.albumName}](${albumUrl})** - ${albumEmojiPrefix}**${streak.albumPlaycount}** ${albumPlayWord}`,
        );
      }

      // Track line
      if (streak.trackPlaycount > 1) {
        const trackUrl = `https://last.fm/music/${encodeURIComponent(streak.artistName)}/_/${encodeURIComponent(streak.trackName)}`;
        const trackEmoji = getEmojiForStreakCount(streak.trackPlaycount);
        const trackEmojiPrefix = trackEmoji ? `${trackEmoji} ` : '';
        const trackPlayWord = streak.trackPlaycount === 1 ? 'play' : 'plays';
        musicLines.push(
          `\` Track:\` **[${streak.trackName}](${trackUrl})** - ${trackEmojiPrefix}**${streak.trackPlaycount}** ${trackPlayWord}`,
        );
      }

      // Genre line
      if (streak.genrePlaycount > 1 && streak.genreName) {
        const genreEmoji = getEmojiForStreakCount(streak.genrePlaycount);
        const genreEmojiPrefix = genreEmoji ? `${genreEmoji} ` : '';
        const genrePlayWord = streak.genrePlaycount === 1 ? 'play' : 'plays';
        const genreTitle = streak.genreName.charAt(0).toUpperCase() + streak.genreName.slice(1);
        musicLines.push(
          `\` Genre:\` **${genreTitle}** - ${genreEmojiPrefix}**${streak.genrePlaycount}** ${genrePlayWord}`,
        );
      }

      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(musicLines.join('\n')));

      const startUnix = Math.floor(streak.streakStarted.getTime() / 1000);
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Streak started <t:${startUnix}:R>.`));

      // Classic embed fallback
      res.embed.setTitle(null);
      res.embed.setDescription(
        `${headerTitle}\n\n${musicLines.join('\n')}\n\nStreak started <t:${startUnix}:R>.`,
      );
    } else {
      const noStreakText = 'No active streak found.\nTry scrobbling multiple of the same artist, album, track or genre in a row to get started.';
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(noStreakText));

      res.embed.setTitle(null);
      res.embed.setDescription(`${headerTitle}\n\n${noStreakText}`);
    }

    res.setComponentsV2Container(container);
    return res;
  }
}
