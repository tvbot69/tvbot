import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject, container } from 'tsyringe';
import { MusicIntelligenceService, type GapEntityType } from '@bot/services/library/musicIntelligenceService';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { UserService } from '@bot/services/user/userService';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { DiscordConstants } from '@bot/resources/discordConstants';

@injectable()
export class IntelligenceInteractions {
  constructor(
    @inject(MusicIntelligenceService) private readonly intelligenceService: MusicIntelligenceService,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService: ColorService,
    @inject(ArtworkService) private readonly artworkService?: ArtworkService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    // CORRECT AS IS, and the reason is the absence of a catch.
    // `MusicIntelligenceService.getGuildAffinity`, `getDiscoveries` and
    // `getListeningGaps` raise when the database is unreachable. There is no
    // local `try` here, so that raise reaches
    // `interactionHandler.onInteractionCreated`, which names the source to the
    // presser. A local catch is what turns a precise failure into a generic
    // one, and the one class it would swallow is `SourceUnavailableError` -
    // the exact signal that says "do not render a card from nothing".
    //
    // The `parts.length` early returns below guard a malformed customId, which
    // is a caller bug rather than a data source, and `guild.members.fetch()
    // .catch(() => null)` falling back to the Last.fm username is a designed
    // degradation of a Discord read, not a wrong number. The
    // `update().catch(() => deferUpdate())` triples are transport, and a nav
    // target that cannot render must leave the page the user is on alone.

    if (customId.startsWith('affinity-page:')) {
      await this.handleAffinityPage(interaction);
      return;
    }

    if (customId.startsWith('discoveries-page:')) {
      await this.handleDiscoveriesPage(interaction);
      return;
    }

    if (customId.startsWith('gaps-page:')) {
      await this.handleGapsPage(interaction);
      return;
    }
  }

  private async handleAffinityPage(interaction: ButtonInteraction): Promise<void> {
    // affinity-page:action:callerId:targetId:page:totalPages
    const parts = interaction.customId.split(':');
    if (parts.length < 6) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const currentPage = parseInt(parts[4]!, 10) || 1;
    const totalPages = parseInt(parts[5]!, 10) || 1;

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;

    const lookupId = targetDiscordId !== '0' ? targetDiscordId : callerDiscordId;
    const targetUser = await this.userService.getUserByDiscordId(lookupId);
    if (!targetUser || !interaction.guild) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const member = await interaction.guild.members.fetch(lookupId).catch(() => null);
    const displayName = member?.displayName || targetUser.userNameLastFm;

    const affinityData = await this.intelligenceService.getGuildAffinity(
      interaction.guild.id,
      targetUser.userId,
      displayName,
      targetUser.userNameLastFm,
      interaction.guild.name,
    );

    const iconUrl = interaction.guild?.iconURL({ size: 256 }) ?? undefined;
    let accentColor = iconUrl ? await this.colorService.getColorFromImageUrl(iconUrl) : DiscordConstants.LastFmColorRed;
    if (accentColor === DiscordConstants.LastFmColorRed && affinityData.neighbors.length > 0 && affinityData.neighbors[0]?.sharedArtists[0]) {
      const artSvc = this.artworkService ?? container.resolve(ArtworkService);
      const artUrl = await artSvc.getArtistImageUrl(affinityData.neighbors[0].sharedArtists[0]);
      if (artUrl) {
        accentColor = await this.colorService.getColorFromImageUrl(artUrl);
      }
    }

    const response = IntelligenceBuilders.buildAffinityResponse({
      data: affinityData,
      page: newPage,
      pageSize: 12,
      callerDiscordId,
      targetDiscordId,
      accentColor,
    });

    if (response.componentsV2Container) {
      await interaction.update({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      }).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }

  private async handleDiscoveriesPage(interaction: ButtonInteraction): Promise<void> {
    // discoveries-page:action:callerId:targetId:page:totalPages
    const parts = interaction.customId.split(':');
    if (parts.length < 6) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const currentPage = parseInt(parts[4]!, 10) || 1;
    const totalPages = parseInt(parts[5]!, 10) || 1;

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;

    const lookupId = targetDiscordId !== '0' ? targetDiscordId : callerDiscordId;
    const targetUser = await this.userService.getUserByDiscordId(lookupId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const end = new Date();
    const items = await this.intelligenceService.getDiscoveries(targetUser.userId, start, end);

    const member = interaction.guild?.members.cache.get(lookupId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;

    const artSvc = this.artworkService ?? container.resolve(ArtworkService);
    let accentColor = DiscordConstants.LastFmColorRed;
    if (items.length > 0 && items[0]?.artistName) {
      const artUrl = await artSvc.getArtistImageUrl(items[0].artistName);
      if (artUrl) {
        accentColor = await this.colorService.getColorFromImageUrl(artUrl);
      }
    }

    const response = IntelligenceBuilders.buildDiscoveriesResponse({
      displayName,
      userNameLastFm: targetUser.userNameLastFm,
      periodDescription: 'the past 90 days',
      items,
      page: newPage,
      pageSize: 10,
      callerDiscordId,
      targetDiscordId,
      accentColor,
    });

    if (response.componentsV2Container) {
      await interaction.update({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      }).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }

  private async handleGapsPage(interaction: ButtonInteraction): Promise<void> {
    // gaps-page:action:callerId:targetId:entityType:page:totalPages
    const parts = interaction.customId.split(':');
    if (parts.length < 7) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const entityType = parts[4]! as GapEntityType;
    const currentPage = parseInt(parts[5]!, 10) || 1;
    const totalPages = parseInt(parts[6]!, 10) || 1;

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;

    const lookupId = targetDiscordId !== '0' ? targetDiscordId : callerDiscordId;
    const targetUser = await this.userService.getUserByDiscordId(lookupId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const items = await this.intelligenceService.getListeningGaps(targetUser.userId, entityType, 90);

    const member = interaction.guild?.members.cache.get(lookupId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;

    const artSvc = this.artworkService ?? container.resolve(ArtworkService);
    let accentColor = DiscordConstants.LastFmColorRed;
    if (items.length > 0 && items[0]) {
      const top = items[0];
      let artUrl: string | null = null;
      if (entityType === 'artist') {
        artUrl = await artSvc.getArtistImageUrl(top.name);
      } else if (entityType === 'album') {
        artUrl = await artSvc.getAlbumCoverUrl(top.name, top.artistName ?? '');
      } else {
        artUrl = await artSvc.getTrackCoverUrl(top.name, top.artistName ?? '');
      }
      if (artUrl) {
        accentColor = await this.colorService.getColorFromImageUrl(artUrl);
      }
    }

    const response = IntelligenceBuilders.buildListeningGapsResponse({
      displayName,
      userNameLastFm: targetUser.userNameLastFm,
      entityType,
      items,
      page: newPage,
      pageSize: 10,
      callerDiscordId,
      targetDiscordId,
      accentColor,
    });

    if (response.componentsV2Container) {
      await interaction.update({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      }).catch(async () => {
        await interaction.deferUpdate().catch(() => undefined);
      });
    }
  }
}
