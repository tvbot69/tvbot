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
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(params.userNameLastFm)}/library/tracks`;
    const titleText = `### 🧾 Top ${params.periodDescription} tracks for [${params.displayName}](${userUrl})`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const mediaGallery = new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL('attachment://receipt.png'),
    );
    container.addMediaGalleryComponents(mediaGallery);

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setFile(params.imageBuffer, 'receipt.png', 'Your listening receipt');
    response.setComponentsV2Container(container);
    return response;
  }
}
