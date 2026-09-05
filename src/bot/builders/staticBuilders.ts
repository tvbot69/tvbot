import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { formatNumber } from '@domain/extensions/stringExtensions';

export class StaticBuilders {
  public static buildPingResponse(gatewayLatencyMs: number, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.embed.setDescription(`Pong! Gateway latency: \`${formatNumber(gatewayLatencyMs)}ms\``);
    return response;
  }
}
