import { ButtonInteraction, MessageFlags } from 'discord.js';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { ArtistTrackService } from '@bot/services/artistTrackService';
import { ColorService } from '@bot/services/colorService';
import { container } from 'tsyringe';

export class ArtistTrackInteractions {
  private readonly artistTrackService: ArtistTrackService;
  private readonly colorService: ColorService;

  constructor() {
    this.artistTrackService = container.resolve(ArtistTrackService);
    this.colorService = container.resolve(ColorService);
  }

  public async handle(interaction: ButtonInteraction): Promise<void> {
    const id = interaction.customId;
    if (id.startsWith('artist-overview')) {
      const { ArtistInteractions } = await import('./artistInteractions');
      const handler = container.resolve(ArtistInteractions);
      await handler.handle(interaction);
      return;
    }

    if (!id.startsWith('at:')) return;
    const parts = id.split(':');
    const action = parts[1];
    const currentPage = Number(parts[2] ?? 0);
    const artistIdentifier = decodeURIComponent(parts[3] ?? '');
    const targetUserId = parts[4] && parts[4] !== '0' ? parts[4] : interaction.user.id;
    const authorUserId = parts[5] && parts[5] !== '0' ? parts[5] : interaction.user.id;

    // Resolve artist name from DB or identifier
    let artistName = artistIdentifier;
    let artistId: number | string = artistIdentifier;
    if (!isNaN(Number(artistIdentifier)) && Number(artistIdentifier) > 0) {
      const dbArt = await import('@persistence/prismaClient').then(m => m.prisma.artist.findUnique({
        where: { artistId: Number(artistIdentifier) },
        select: { artistId: true, name: true },
      }));
      if (dbArt) {
        artistName = dbArt.name;
        artistId = dbArt.artistId;
      }
    }

    const userService = container.resolve((await import('@bot/services/userService')).UserService) as any;
    const user = await userService.getUserByDiscordId(targetUserId) ?? await userService.getUserByDiscordId(interaction.user.id);
    if (!user) { await interaction.reply({ content: 'Not registered.', flags: MessageFlags.Ephemeral }).catch(() => undefined); return; }

    const tracks = await this.artistTrackService.getTopTracksForArtist(user.userId, artistName);
    const totalPlays = await this.artistTrackService.getTotalArtistPlays(user.userId, artistName);
    const distinct = await this.artistTrackService.getDistinctTrackCount(user.userId, artistName);
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(tracks.length / perPage));
    let targetPage = currentPage;
    if (action === 'first') targetPage = 0;
    else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
    else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
    else if (action === 'last') targetPage = totalPages - 1;
    const displayName = (interaction.guild as any)?.members.cache.get(targetUserId)?.displayName ?? user.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);
    const response = ArtistTrackBuilders.buildArtistTopTracksResponse(
      artistName,
      displayName,
      tracks,
      totalPlays,
      distinct,
      targetPage,
      accentColor,
      artistId,
      targetUserId,
      authorUserId,
    );
    await interaction.update({ components: [response.componentsV2Container as any], flags: MessageFlags.IsComponentsV2 } as any).catch(() => undefined);
  }
}
