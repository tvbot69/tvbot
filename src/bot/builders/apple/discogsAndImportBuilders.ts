import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { ImportSummary } from '@bot/services/library/importService';

export class DiscogsAndImportBuilders {

  public static buildImportInstructionsResponse(params: {
    instructions: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.SuccessColorGreen);

    // `setContent('')` throws, so an empty instruction body would be an unsendable
    // card rather than a blank one. The bodies are static strings today; the guard
    // is here so that stops being load-bearing.
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        params.instructions || '*No import instructions are available right now.*',
      ),
    );

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

    const added = (summary.newRowsInserted ?? summary.totalScrobblesImported).toLocaleString();
    const content =
      `• **${added}** valid scrobbles added` +
      (summary.newRowsInserted !== undefined && summary.newRowsInserted < summary.totalScrobblesImported
        ? ` (${summary.totalScrobblesImported.toLocaleString()} parsed, rest already in your library)\n`
        : '\n') +
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
}

