import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

export class GenericEmbedService {
  public static buildCommandErrorResponse(
    commandResponse: CommandResponse,
    description: string,
  ): ResponseModel {
    const response = new ResponseModel(DiscordConstants.ErrorColorRed);
    response.commandResponse = commandResponse;
    response.embed.setDescription(description);
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
    response.embed.setDescription(description);
    return response;
  }

  public static buildInfoResponse(description: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.embed.setDescription(description);
    return response;
  }
}
