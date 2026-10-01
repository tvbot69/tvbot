import { ResponseModel } from '@bot/models/responseModel';

import { formatNumber } from '@domain/text/stringExtensions';

export class StaticBuilders {
  public static buildPingResponse(gatewayLatencyMs: number, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.embed.setDescription(`Pong! Gateway latency: \`${formatNumber(gatewayLatencyMs)}ms\``);
    return response;
  }
}
