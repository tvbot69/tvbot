import {
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

export class ReceiptBuilders {
  public static buildReceiptResponse(params: {
    displayName: string;
    userNameLastFm: string;
    periodDescription: string;
    imageBuffer: Buffer;
    tracksUrl?: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    // Do NOT set accent color on the container so Discord renders a clean theme-matching card without dark tint

    const userUrl =
      params.tracksUrl ??
      `https://last.fm/user/${encodeURIComponent(params.userNameLastFm)}/library/tracks`;
    const titleText = `**[Top ${params.periodDescription} tracks](${userUrl}) for ${params.displayName}**`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));

    const mediaGallery = new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL('attachment://receipt.png'),
    );
    container.addMediaGalleryComponents(mediaGallery);

    const response = new ResponseModel();
    response.commandResponse = CommandResponse.Ok;
    response.setFile(params.imageBuffer, 'receipt.png', 'Your listening receipt');
    response.setComponentsV2Container(container);
    return response;
  }
}
