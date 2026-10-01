import { memberDisplayName } from '@domain/interfaces/discord/guildMember';
import { inject, injectable , container} from 'tsyringe';
import { ButtonInteraction, MessageFlags } from 'discord.js';
import { ArtistTrackBuilders } from '@bot/builders/library/artistTrackBuilders';
import { ArtistTrackService, isArtistIndexPartial } from '@bot/services/library/artistTrackService';
import { ColorService } from '@bot/services/system/colorService';

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
      const { ArtistInteractions } = await import('@bot/interactions/library/artistInteractions');
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

    const { UserService } = await import('@bot/services/user/userService');
    const userService = container.resolve(UserService);
    const user = await userService.getUserByDiscordId(targetUserId) ?? await userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      // CORRECT AS IS: a genuine absence, and it is `userService` that draws the
      // line. `getUserByDiscordId` reads prisma with no try/catch, so a database
      // failure RAISES through this branch to
      // `interactionHandler.onInteractionCreated` and is reported to the presser
      // with a source-named message. Reaching here means both lookups ran and
      // found no row, so "Not registered" is true. Note also the second lookup
      // falls back to the presser's own account, so a button minted for someone
      // who has since unlinked still renders against the person pressing it.
      await interaction.reply({ content: 'Not registered.', flags: MessageFlags.Ephemeral }).catch(() => undefined); return;
    }


    // CORRECT AS IS: this read is deliberately UNPROTECTED, and the asymmetry
    // with `ArtistInteractions` is the point. `artistTrackService.getTopTracksForArtist`
    // raises rather than returning an empty track list, and nothing here catches
    // it, so the failure propagates to `interactionHandler.onInteractionCreated`
    // - a real boundary that answers the presser ephemerally ("Sorry, something
    // went wrong while processing this interaction"), or lets Discord's own
    // "This interaction failed" stand if the ack guard already fired. Either way
    // the user is told. A local `catch { deferUpdate() }` - the shape
    // `artistInteractions` and `playcountInteractions` used to have - converts
    // that into a card that silently does not move, which is indistinguishable
    // from "this artist has no indexed plays". Left alone: adding a catch here
    // would be the bug, not the fix.
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
        // CORRECT AS IS: transport, and the guard below is what makes it safe.
        // The `update` is a pure render of `tracks`, `totalPlays` and `distinct`,
        // all of which came from the unprotected reads further up - so if those
        // raised, we never reach this line at all. A rejected `update` leaves the
        // page the user is on exactly as it was, which is the "a nav target that
        // cannot render must not destroy the current view" rule the rest of this
        // directory follows.
        //
        // The comment sits ABOVE the `if` deliberately: `componentsV2Guard.test`
        // proves a payload is guarded by scanning the 600 characters before the
        // post, so a long note between the guard and the use reads as an
        // unguarded payload. The code is unchanged either way.
        if (response.componentsV2Container) {
          await interaction.update({ components: [response.componentsV2Container], flags: MessageFlags.IsComponentsV2 }).catch(() => undefined);
        }

  }
}
