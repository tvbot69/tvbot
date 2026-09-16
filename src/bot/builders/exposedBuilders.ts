import { EmbedBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import type { ExposedReport } from '@bot/services/exposedService';

export class ExposedBuilders {
  private static readonly ACCENT_COLOR = 0xff3b30; // Neon red / alert crimson

  public static buildExposedResponse(
    report: ExposedReport,
    avatarUrl?: string | null,
  ): ResponseModel {
    const embed = new EmbedBuilder()
      .setTitle(`📸 CAUGHT IN 4K: ${report.displayName}`)
      .setColor(ExposedBuilders.ACCENT_COLOR);

    if (avatarUrl) {
      embed.setThumbnail(avatarUrl);
    }

    // Public persona
    const artistsList = report.publicArtists.length > 0 ? report.publicArtists.join(', ') : 'Unknown';
    const genresList = report.publicGenres.length > 0 ? report.publicGenres.join(' · ') : 'Diverse';
    embed.addFields({
      name: '🎭 Public Persona',
      value: `**Known for:** ${artistsList}\n**Usual Vibe:** \`${genresList}\``,
      inline: false,
    });

    // The guilty pleasures found
    const pleasureLines = report.guiltyPleasures.map((p, idx) => {
      const trackSnippet = p.trackName ? ` — *"${p.trackName}"*` : '';
      const genreTags = p.genres.length > 0 ? `(\`${p.genres.join(' · ')}\`)` : '';
      return `**${idx + 1}. ${p.artistName}**${trackSnippet}\n↳ **${p.playcount} plays** ${genreTags} • *${p.reason}*`;
    });

    embed.addFields({
      name: '🩻 The Secret Vault (Caught)',
      value: pleasureLines.join('\n\n'),
      inline: false,
    });

    // The Verdict (Roast)
    embed.addFields({
      name: '💀 The Verdict',
      value: `> *"${report.roast}"*`,
      inline: false,
    });

    // Shame bar / Down bad index
    const filledBlocks = Math.round(report.shameScore / 10);
    const emptyBlocks = 10 - filledBlocks;
    const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

    embed.addFields({
      name: '📊 Down Bad Index',
      value: `\`[${progressBar}]\` **${report.shameScore}% Guilty**`,
      inline: false,
    });

    embed.setFooter({
      text: 'tvbot 4K Exposure Engine • Aux cord privileges: Suspended ⚠️',
    });
    embed.setTimestamp();

    const response = new ResponseModel(ExposedBuilders.ACCENT_COLOR);
    response.embed = embed;
    return response;
  }

  public static buildCleanRecordResponse(displayName: string): ResponseModel {
    const embed = new EmbedBuilder()
      .setTitle(`🔍 4K Scan Complete: ${displayName}`)
      .setColor(0x57f287) // Green
      .setDescription(
        `We dug through the database, cross-referenced the genre tables, and found **zero secret guilty pleasures**.\n\n` +
          `Either <@${displayName}> has genuinely impenetrable music integrity, or they're extraordinarily careful with their scrobbles. 🤝`,
      )
      .setFooter({ text: 'tvbot 4K Exposure Engine • Status: Cleared' });

    const response = new ResponseModel(0x57f287);
    response.embed = embed;
    return response;
  }
}
