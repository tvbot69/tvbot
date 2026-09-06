import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { JumbleSession, UserGameStats } from '@bot/services/gameService';

export class GameBuilders {
  public static buildJumbleStartResponse(session: JumbleSession, accentColor?: number | null): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### 🧩 Jumble: Guess the Artist!'),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const clue = session.hints[0] ?? '';
    const mainText =
      `# \`${session.displayTarget}\`\n\n` +
      `**Letter Clue:** \`${clue}\`\n` +
      (session.hintsShown > 0
        ? `\n**Extra Hints:**\n${session.hints.slice(1, session.hintsShown + 1).map(h => `• ${h}`).join('\n')}\n`
        : '');

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(mainText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const footerText = '-# ⏱️ 25 seconds to guess! Type your answer directly in this channel.';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`game:hint:${session.sessionId}`)
        .setLabel('💡 Hint')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(session.hintsShown >= session.hints.length - 1),
      new ButtonBuilder()
        .setCustomId(`game:reshuffle:${session.sessionId}`)
        .setLabel('🔄 Reshuffle')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`game:giveup:${session.sessionId}`)
        .setLabel('🏳️ Give Up')
        .setStyle(ButtonStyle.Danger),
    );

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.addButtonRow(0, actionRow);
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildPixelStartResponse(
    session: JumbleSession,
    pixelatedBuffer: Buffer,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### 🎨 Pixelation: Guess the Album!'),
    );

    const mediaItem = new MediaGalleryItemBuilder().setURL('attachment://pixel-cover.png');
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(mediaItem));

    const clue = session.hints[0] ?? '';
    const mainText =
      `**Artist:** **${session.artistName}**\n` +
      `**Letter Clue:** \`${clue}\``;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(mainText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const footerText = '-# ⏱️ 40 seconds to guess! Type your answer directly in this channel.';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`game:hint:${session.sessionId}`)
        .setLabel('🔍 Enhance')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(session.blurLevel >= 0.12),
      new ButtonBuilder()
        .setCustomId(`game:giveup:${session.sessionId}`)
        .setLabel('🏳️ Give Up')
        .setStyle(ButtonStyle.Danger),
    );

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setFile(pixelatedBuffer, 'pixel-cover.png', 'Pixelated album cover');
    response.addButtonRow(0, actionRow);
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildGameWonResponse(
    session: JumbleSession,
    timeSeconds: number,
    stats: UserGameStats,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? 0x57f287);

    const title = session.type === 'artist' ? '🎉 Artist Jumble Solved!' : '🎉 Album Guess Solved!';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const detail =
      session.type === 'artist'
        ? `Winner: <@${session.winnerDiscordId}>\nCorrect Answer: **${session.correctAnswer}**`
        : `Winner: <@${session.winnerDiscordId}>\nAlbum: **${session.correctAnswer}** by **${session.artistName}**`;

    const streakText = stats.streak > 1 ? ` · 🔥 Streak: **${stats.streak}**` : '';
    const statsLine = `⚡ Answered in **${timeSeconds.toFixed(1)}s**${streakText}`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${detail}\n\n${statsLine}`),
    );

    const response = new ResponseModel(0x57f287);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildGameExpiredResponse(
    session: JumbleSession,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.WarningColorOrange);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("### ⏰ Time's Up!"));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const answer =
      session.type === 'artist'
        ? `The artist was **${session.correctAnswer}**.`
        : `The album was **${session.correctAnswer}** by **${session.artistName}**.`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`Nobody guessed in time!\n\n${answer}`),
    );

    const response = new ResponseModel(accentColor ?? DiscordConstants.WarningColorOrange);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildGameGiveUpResponse(
    session: JumbleSession,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? 0xed4245);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('### 🏳️ Game Given Up!'));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const answer =
      session.type === 'artist'
        ? `The artist was **${session.correctAnswer}**.`
        : `The album was **${session.correctAnswer}** by **${session.artistName}**.`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`The game has ended.\n\n${answer}`),
    );

    const response = new ResponseModel(accentColor ?? 0xed4245);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildGameStatsResponse(
    displayName: string,
    stats: UserGameStats,
    accentColor?: number | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) container.setAccentColor(accentColor);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🎮 Game Statistics for ${displayName}`),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const winRate =
      stats.totalPlayed > 0 ? ((stats.totalWon / stats.totalPlayed) * 100).toFixed(1) : '0.0';

    const lines = [
      `• **Games Played:** ${stats.totalPlayed}`,
      `• **Games Won:** ${stats.totalWon}`,
      `• **Win Rate:** ${winRate}%`,
      `• **Avg. Time to Solve:** ${stats.avgTimeSeconds > 0 ? stats.avgTimeSeconds.toFixed(1) + 's' : 'N/A'}`,
      `• **Current Streak:** ${stats.streak} days`,
      `• **Best Streak:** ${stats.bestStreak} days`,
    ];

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
