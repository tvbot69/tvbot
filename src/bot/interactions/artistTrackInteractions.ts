import { memberDisplayName } from '@domain/interfaces/guildMember';
import { inject, injectable , container} from 'tsyringe';
import { ButtonInteraction, MessageFlags } from 'discord.js';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { ArtistTrackService, isArtistIndexPartial } from '@bot/services/artistTrackService';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class ArtistTrackInteractions {

  constructor(
    @inject(ArtistTrackService)
    private readonly artistTrackService: ArtistTrackService,
    @inject(ColorService)
    private readonly colorService: ColorService,
  ) {
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

    const { UserService } = await import('@bot/services/userService');
    const userService = container.resolve(UserService);
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
    const displayName = memberDisplayName(interaction.guild, targetUserId) ?? user.userNameLastFm;
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
      isArtistIndexPartial(tracks, totalPlays),
    );
        // Guarded, matching the sibling handlers. The builder always sets a
        // container, so this is a no-op today - but ResponseModel types the
        // field optional, and unguarded this posts `[undefined]` with the
        // Components V2 flag, which is the failure already fixed in
        // profileInteractions. The `as any` was hiding the missing guard.
        if (response.componentsV2Container) {
          await interaction.update({ components: [response.componentsV2Container], flags: MessageFlags.IsComponentsV2 }).catch(() => undefined);
        }
  }
}
