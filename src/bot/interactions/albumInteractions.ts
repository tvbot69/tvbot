import { type ButtonInteraction, MessageFlags } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import { AlbumService } from '@bot/services/albumService';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/system/colorService';
import { AlbumBuilders } from '@bot/builders/albumBuilders';

import { Logger } from '@domain/logger';

export const ALBUM_BUTTON_PREFIXES = ['album-info:', 'album-tracks:', 'album-cover:'];

/**
 * Ephemeral note that leaves the card the user is looking at alone.
 *
 * The `!interaction.deferred` gate this used to carry is the exact regression
 * `interactionHandler.onInteractionCreated` documents and fixed: all three
 * handlers below call `deferUpdate()` BEFORE they read, precisely so a slow
 * source is acknowledged inside Discord's 3s window - so the one failure that
 * most needed a reply (a press that failed halfway through) was the one failure
 * that got silence. A `SourceUnavailableError` from `getAlbumById` or
 * `searchAlbum` therefore rendered as a button press that did nothing at all.
 *
 * `followUp` is the right verb once deferred and `reply` before it, and
 * neither rewrites the components, so the album card the user opened survives.
 */
const respondEphemeral = async (interaction: ButtonInteraction, content: string): Promise<void> => {
  if (!interaction.isRepliable()) {
    return;
  }
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
};

@injectable()
export class AlbumInteractions {
  private readonly albumService: AlbumService;
  private readonly userService: UserService;
  private readonly colorService: ColorService;

  constructor(
    @inject(AlbumService) albumService: AlbumService,
    @inject(UserService) userService: UserService,
    @inject(ColorService) colorService: ColorService,
  ) {
    this.albumService = albumService;
    this.userService = userService;
    this.colorService = colorService;
  }

  public async handleAlbumButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    try {
      if (customId.startsWith('album-info:')) {
        await this.handleAlbumInfo(interaction);
      } else if (customId.startsWith('album-tracks:')) {
        await this.handleAlbumTracks(interaction);
      } else if (customId.startsWith('album-cover:')) {
        await this.handleAlbumCover(interaction);
      }
    } catch (err) {
      Logger.error({ err }, `Error handling album interaction: ${customId}`);
      await respondEphemeral(interaction, 'Something went wrong processing this interaction.');
    }
  }

  private async handleAlbumInfo(interaction: ButtonInteraction): Promise<void> {
    // album-info:<albumId>:<targetDiscordId>:<requesterDiscordId>
    const parts = interaction.customId.split(':');
    const albumId = Number(parts[1]);
    const targetDiscordId = parts[2] || interaction.user.id;

    const user = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!user) {
      await interaction.reply({ content: 'User profile not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    const albumRecord = await this.albumService.getAlbumById(albumId);
    if (!albumRecord) {
      await interaction.reply({ content: 'Album record not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    const result = await this.albumService.searchAlbum(
      `${albumRecord.artistName} | ${albumRecord.albumName}`,
      user,
      interaction.guildId,
    );

    if (!result) {
      // `null` here is an honest answer - Last.fm has no such album, or the
      // artist row the id pointed at has no name to search with - and this file
      // already says so for the two misses above. It used to `return` instead,
      // after `deferUpdate()`, so the press produced no card and no message:
      // the user cannot tell "that album does not exist" from "the button is
      // broken", and the message they were looking at stays on screen saying
      // nothing happened. Say it, ephemerally, without touching that message.
      await respondEphemeral(interaction, 'I could not find that album.');
      return;
    }

    const requesterName = interaction.user.displayName || user.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(targetDiscordId || interaction.user.id);
    const response = AlbumBuilders.buildAlbumInfoResponse(result, user, requesterName, accentColor);

    if (response.componentsV2Container) {
      await interaction.editReply({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }

  private async handleAlbumTracks(interaction: ButtonInteraction): Promise<void> {
    // album-tracks:<albumId>:<targetDiscordId>:<requesterDiscordId>:<page?>
    const parts = interaction.customId.split(':');
    const albumId = Number(parts[1]);
    const targetDiscordId = parts[2] || interaction.user.id;
    const page = Number(parts[4]) || 1;

    const user = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!user) {
      await interaction.reply({ content: 'User profile not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    const albumRecord = await this.albumService.getAlbumById(albumId);
    if (!albumRecord) {
      await interaction.reply({ content: 'Album record not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    const result = await this.albumService.searchAlbum(
      `${albumRecord.artistName} | ${albumRecord.albumName}`,
      user,
      interaction.guildId,
    );

    if (!result) {
      await respondEphemeral(interaction, 'I could not find that album.');
      return;
    }

    const requesterName = interaction.user.displayName || user.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(targetDiscordId || interaction.user.id);
    const response = AlbumBuilders.buildAlbumTracksResponse(result, user, requesterName, page, accentColor);

    if (response.componentsV2Container) {
      await interaction.editReply({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }

  private async handleAlbumCover(interaction: ButtonInteraction): Promise<void> {
    // album-cover:<albumId>:<targetDiscordId>:<requesterDiscordId>:motion:
    const parts = interaction.customId.split(':');
    const albumId = Number(parts[1]);
    const targetDiscordId = parts[2] || interaction.user.id;

    const user = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!user) {
      await interaction.reply({ content: 'User profile not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    const albumRecord = await this.albumService.getAlbumById(albumId);
    if (!albumRecord) {
      await interaction.reply({ content: 'Album record not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    const result = await this.albumService.searchAlbum(
      `${albumRecord.artistName} | ${albumRecord.albumName}`,
      user,
      interaction.guildId,
    );

    if (!result) {
      await respondEphemeral(interaction, 'I could not find that album.');
      return;
    }

    const requesterName = interaction.user.displayName || user.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(targetDiscordId || interaction.user.id);
    const response = AlbumBuilders.buildCoverResponse(result, user, requesterName, accentColor);

    if (response.componentsV2Container) {
      await interaction.editReply({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }
}
