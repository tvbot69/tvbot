import { type ButtonInteraction, MessageFlags } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import { AlbumService } from '@bot/services/albumService';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { AlbumBuilders } from '@bot/builders/albumBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { Logger } from '@domain/logger';

export const ALBUM_BUTTON_PREFIXES = ['album-info:', 'album-tracks:', 'album-cover:'];

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
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong processing this interaction.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
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
