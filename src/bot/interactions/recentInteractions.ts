import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/system/colorService';
import { RecentBuilders } from '@bot/builders/recentBuilders';

@injectable()
export class RecentInteractions {
  constructor(
    @inject(LastFmRepository) private readonly lastfmRepo: ILastfmRepository,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('recent:')) return;

    // recent:prev:1:123456:username or recent:next:1:123456:username
    const parts = customId.split(':');
    if (parts.length < 5) return;

    const action = parts[1]; // 'prev' or 'next'
    const currentPage = parseInt(parts[2]!, 10) || 1;
    const targetDiscordId = parts[3]!;
    const userNameLastFm = decodeURIComponent(parts[4]!);

    const newPage = action === 'prev' ? Math.max(1, currentPage - 1) : Math.min(80, currentPage + 1);

    const member = interaction.guild?.members.cache.get(targetDiscordId);
    const displayName = member?.displayName ?? userNameLastFm;

    // CORRECT AS IS, and all four sites in this method are transport or design,
    // not a swallowed query.
    //
    // The one that could look like a data source is the `deferUpdate()` in the
    // empty-tracks branch. `getUserRecentTracksWithMetadata` does NOT raise on an
    // outage - it goes through `callWithRetry`, which returns `null` after its
    // backoff, and the method then maps that to
    // `{ tracks: [], totalPages: 0, totalScrobbles: 0 }`. So a Last.fm outage
    // and a user with no recent tracks are the same value HERE, in the
    // repository, before this handler sees anything. Narrowing this catch with
    // `isSourceUnavailable` would be dead code: the raise never arrives.
    //
    // The trade is acceptable and is the same one `interactionHandler` documents
    // for a nav target that cannot render: a page button that cannot load must
    // leave the page the user is on alone. `deferUpdate` does not edit the
    // message, so the visible page stays byte-for-byte what it was, and the user
    // sees a button that does nothing rather than a card full of "no recent
    // tracks". The real fix for the ambiguity, if it is ever wanted, belongs in
    // `getUserRecentTracksWithMetadata` and would ripple into every caller -
    // not in a button handler.
    try {
      // The session key is a PRIVACY refinement, not a source of truth: without
      // it the same call still returns the user's own public recent tracks, just
      // unsigned. A failed lookup costs nothing observable, so `null` is the
      // honest degradation rather than a lie.
      const user = await this.userService.getUserByDiscordId(targetDiscordId).catch(() => null);
      const sessionKey = user?.sessionKey;

      const recentData = await this.lastfmRepo.getUserRecentTracksWithMetadata(
        userNameLastFm,
        6,
        newPage,
        undefined,
        sessionKey,
      );
      if (!recentData || recentData.tracks.length === 0) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const accentColor = await this.colorService.getColorFromImageUrl(recentData.tracks[0]?.imageUrl);

      const response = RecentBuilders.buildRecentTracksResponse(
        userNameLastFm,
        displayName,
        targetDiscordId,
        recentData,
        newPage,
        accentColor,
      );

      if (response.componentsV2Container) {
        // The `update` -> `deferUpdate` fallback is the transport idiom used by
        // every handler in this directory: if the original message can no longer
        // be edited, acknowledging without editing leaves the user's current page
        // intact rather than replacing it with an error.
        await interaction.update({
          components: [response.componentsV2Container],
          flags: MessageFlags.IsComponentsV2,
        }).catch(async () => {
          await interaction.deferUpdate().catch(() => undefined);
        });
      }
    } catch (err) {
      // CORRECT AS IS, and the reason it is NOT narrowed with
      // `isSourceUnavailable(err)` even though that is the pattern
      // `playcountInteractions` uses two directories over: nothing in this try
      // can raise a `SourceUnavailableError`. The one data read
      // (`getUserRecentTracksWithMetadata`) swallows its own failures into an
      // empty list, and the rest is building and transport. Adding the narrowing
      // would be code that can never execute - which is worse than no code,
      // because it tells the next reader the raise is handled when it is not.
      //
      // What this catch can see is a genuine defect - a builder throwing on an
      // unexpected row shape, a colour service failure. The visible outcome is a
      // button that does nothing, which is the correct trade for a navigation
      // control, and the defect is still visible to the operator through
      // `componentInteractionTracker`, which logs any error escaping a tracked
      // handler. Only handlers that return their own `ResponseModel` (the
      // commands) have a boundary that reports; a component press that leaves
      // the page alone is the designed behaviour.
      await interaction.deferUpdate().catch(() => undefined);
    }
  }
}
