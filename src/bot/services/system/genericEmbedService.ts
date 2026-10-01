import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

/**
 * Discord's embed description limit. `EmbedBuilder.setDescription` ASSERTS
 * 1..4096 and THROWS on violation (the builders package runs with validation
 * on), so a long user-supplied string — a 240-character search query, a huge
 * track title — crashed the command instead of rendering. Everything that
 * interpolates user input into an embed funnels through here.
 */
const MAX_DESCRIPTION = 4096;

/** Clamp to Discord's limit with a visible ellipsis. Never returns ''. */
const clampText = (text: string, max: number): string => {
  const t = text ?? '';
  if (t.length <= max) return t.length === 0 ? ' ' : t;
  return `${t.slice(0, max - 1)}…`;
};

export class GenericEmbedService {
  public static buildCommandErrorResponse(
    commandResponse: CommandResponse,
    description: string,
  ): ResponseModel {
    const response = new ResponseModel(DiscordConstants.ErrorColorRed);
    response.commandResponse = commandResponse;
    response.embed.setDescription(clampText(description, MAX_DESCRIPTION));
    return response;
  }

  public static buildNotFoundResponse(description: string): ResponseModel {
    return this.buildCommandErrorResponse(CommandResponse.NotFound, description);
  }

  public static buildWrongInputResponse(description: string): ResponseModel {
    return this.buildCommandErrorResponse(CommandResponse.WrongInput, description);
  }

  public static buildSuccessResponse(description: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.embed.setDescription(clampText(description, MAX_DESCRIPTION));
    return response;
  }

  public static buildInfoResponse(description: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.embed.setDescription(clampText(description, MAX_DESCRIPTION));
    return response;
  }

  public static buildCustomEmbedResponse(title: string, description: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;
    // Titles assert 1..256 — user input reaches these too.
    response.embed.setTitle(clampText(title, 256));
    response.embed.setDescription(clampText(description, MAX_DESCRIPTION));
    return response;
  }
}
