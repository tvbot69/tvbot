import {
  ButtonInteraction,
  MessageFlags,
  StringSelectMenuInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';
import { injectable, inject, container } from 'tsyringe';
import { CrownService } from '@bot/services/crown/crownService';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { UserService } from '@bot/services/user/userService';
import { ColorService } from '@bot/services/system/colorService';
import { ContextModel } from '@bot/models/contextModel';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import type { CrownViewType } from '@domain/models/crownModels';
import { Logger } from '@domain/logger';

@injectable()
export class CrownInteractions {
  constructor(
    @inject(CrownService) private readonly crownService: CrownService,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  /**
   * The name behind a crown-card button, or `null` when it cannot be read.
   *
   * The two buttons carry DIFFERENT things. `buildCrownDuelResponse` writes
   * `artist-whoknows:${artistId}` - a bare numeric Artist row id, not a name -
   * and the Crown button is written back as `artist-crown:${artistName}` from
   * whatever this method returned last time.
   *
   * So "fall back to `decodeURIComponent`", which is what this used to do on a
   * failed lookup, is not a fallback to a name: decoding "42" yields "42", and
   * the who-knows card was then rendered for an artist called "42" AND that
   * wrong name was stamped into the Crown button's customId, where it survives
   * every later press of a message that is never re-rendered. A read that could
   * not answer is not evidence of an artist, so it is reported instead.
   *
   * The card is a nav target, so a failure leaves the card the user is looking
   * at untouched and says why ephemerally. `followUp` once deferred (the ack
   * guard may have won the race) and `reply` before it.
   */
  private async resolveArtistName(interaction: ButtonInteraction, raw: string): Promise<string | null> {
    const decoded = decodeURIComponent(raw);
    if (!/^\d+$/.test(raw)) {
      // The name was carried in the customId. Nothing to read, nothing to fail.
      return decoded;
    }
    try {
      const artistRepo = container.resolve(ArtistRepository);
      const artist = await artistRepo.getArtistById(parseInt(raw, 10));
      if (artist) {
        return artist.name;
      }
      // The query RAN and the row is gone. Also not an artist called "42" -
      // and distinct from a failure, so it gets its own message.
      Logger.warn({ artistId: raw }, 'Crown card button names an artist row that no longer exists');
      await this.respondEphemeral(interaction, 'That artist is no longer available.');
      return null;
    } catch (err) {
      Logger.warn({ err, artistId: raw }, 'Could not read the artist behind a crown card button');
      await this.respondEphemeral(interaction, 'Could not load that artist. Please try again in a moment.');
      return null;
    }
  }

  private async respondEphemeral(interaction: ButtonInteraction, content: string): Promise<void> {
    if (!interaction.isRepliable()) {
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }

  public async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;
    if (customId === 'user-crownpicker') {
      const selectedValue = interaction.values[0];
      if (!selectedValue) return;

      // format: callerDiscordId-targetDiscordId-viewType
      const parts = selectedValue.split('-');
      if (parts.length < 3) return;

      const callerDiscordId = parts[0]!;
      const targetDiscordId = parts[1]!;
      const viewType = parts[2]! as CrownViewType;

      const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!targetUser) {
        // CORRECT AS IS. `null` is the repository's honest "this Discord id is
        // not a registered user", not a failed read - a failed read raises
        // (see `resolveArtistName` for the other end of this file), and
        // `crownService.getUserCrowns` does not wrap an outage in an empty
        // list. There is no crown card to draw for an unregistered user, and
        // the picker's own message stays on screen either way. No wrong number
        // is produced; inventing a card here would be the worse answer.
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const member = interaction.guild?.members.cache.get(targetDiscordId);
      const displayName = member?.displayName ?? targetUser.userNameLastFm;

      const guildId = interaction.guildId!;
      const crowns = await this.crownService.getUserCrowns(guildId, targetUser.userId, viewType);
      const accentColor = await this.colorService.getAccentColorAsync(guildId);

      const response = CrownBuilders.buildCrownsResponse(
        displayName,
        callerDiscordId,
        targetDiscordId,
        crowns,
        1,
        viewType,
        accentColor,
      );

      if (response.componentsV2Container) {
        await interaction.update({
          components: [response.componentsV2Container],
          flags: MessageFlags.IsComponentsV2,
        }).catch(async () => {
          await interaction.deferUpdate().catch(() => undefined);
        });
      }
      return;
    }

    if (customId === 'guild-members') {
      const selectedValue = interaction.values[0];
      if (!selectedValue) return;

      const guildId = interaction.guildId!;
      const caller = await this.userService.getUserByDiscordId(interaction.user.id);
      const accentColor = await this.colorService.getAccentColorAsync(guildId);
      const guildName = interaction.guild?.name ?? 'Server';

      if (selectedValue === 'Crowns') {
        const { entries, totalActiveCrowns } = await this.crownService.getGuildLeaderboard(guildId);

        for (const item of entries) {
          const m = interaction.guild?.members.cache.get(item.discordUserId);
          if (m) item.displayName = m.displayName;
        }

        const response = CrownBuilders.buildCrownLeaderboardResponse(
          guildName,
          entries,
          caller?.userId,
          1,
          totalActiveCrowns,
          accentColor,
        );

        if (response.componentsV2Container) {
          await interaction.update({
            components: [response.componentsV2Container],
            flags: MessageFlags.IsComponentsV2,
          }).catch(async () => {
            await interaction.deferUpdate().catch(() => undefined);
          });
        }
      }
      return;
    }
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    // No local catch, deliberately. `crownService.getUserCrowns`,
    // `getGuildLeaderboard`, `WhoKnowsCommands.whoKnowsArtistForName` and
    // `CrownCommands.crownAsync` all RAISE when a source fails, and this class
    // has no write path of its own - so there is nothing here that could turn a
    // raise into something that looks like a successful crown change. Letting
    // the throw reach `interactionHandler.onInteractionCreated` is what gets it
    // named ("Could not reach the database"). A catch added here would be the
    // regression that file documents, in the one place that must not have it.
    //
    // The `interaction.update().catch(() => deferUpdate())` pairs below are
    // CORRECT AS IS: they are Discord transport, not a data source, and the
    // recorded trade for a nav target that cannot render is to leave the page
    // the user is looking at alone.

    // 1) Handle WhoKnows button click from crown duel embed
    if (customId.startsWith('artist-whoknows:')) {
      const raw = customId.slice('artist-whoknows:'.length);
      const artistName = await this.resolveArtistName(interaction, raw);
      if (artistName === null) return;

      await interaction.deferUpdate().catch(() => undefined);

      const context = new ContextModel();
      // componentInteraction, not interaction. interaction is typed
      // ChatInputCommandInteraction because every read of it goes through
      // .options, which a ButtonInteraction does not have - so assigning
      // one there typechecked only because of the cast, and any consumer that
      // reached for .options would have thrown at runtime. ContextModel
      // already has the right field, and anyInteraction prefers it.
      context.componentInteraction = interaction;
      context.discordUserId = interaction.user.id;
      context.guildId = interaction.guildId ?? undefined;
      context.accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      const whoKnowsCommands = container.resolve(WhoKnowsCommands);
      const response = await whoKnowsCommands.whoKnowsArtistForName(context, artistName);

      // Add a "Crown" button to allow switching back to the crown embed
      const crownBtn = new ButtonBuilder()
        .setCustomId(`artist-crown:${encodeURIComponent(artistName)}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Crown')
        .setEmoji({ name: '👑' });
      response.addButtonRow(0, new ActionRowBuilder<ButtonBuilder>().addComponents(crownBtn));

      if (response.isComponentsV2 && response.componentsV2Container) {
        await interaction.editReply({
          components: [response.componentsV2Container],
          flags: MessageFlags.IsComponentsV2,
        }).catch(() => undefined);
      } else {
        const hasEmbed = response.hasEmbed();
        await interaction.editReply({
          content: response.content ?? '',
          embeds: hasEmbed ? response.buildEmbed() : [],
          components: response.buildComponents(),
        }).catch(() => undefined);
      }
      return;
    }

    // 2) Handle Crown button click to toggle back to crown duel embed
    if (customId.startsWith('artist-crown:')) {
      const raw = customId.slice('artist-crown:'.length);
      const artistName = await this.resolveArtistName(interaction, raw);
      if (artistName === null) return;

      await interaction.deferUpdate().catch(() => undefined);

      const context = new ContextModel();
      // componentInteraction, not interaction. interaction is typed
      // ChatInputCommandInteraction because every read of it goes through
      // .options, which a ButtonInteraction does not have - so assigning
      // one there typechecked only because of the cast, and any consumer that
      // reached for .options would have thrown at runtime. ContextModel
      // already has the right field, and anyInteraction prefers it.
      context.componentInteraction = interaction;
      context.discordUserId = interaction.user.id;
      context.guildId = interaction.guildId ?? undefined;
      context.accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      const crownCommands = container.resolve(CrownCommands);
      const response = await crownCommands.crownAsync(context, [artistName]);

      if (response.isComponentsV2 && response.componentsV2Container) {
        await interaction.editReply({
          components: [response.componentsV2Container],
          flags: MessageFlags.IsComponentsV2,
        }).catch(() => undefined);
      } else {
        const hasEmbed = response.hasEmbed();
        await interaction.editReply({
          content: response.content ?? '',
          embeds: hasEmbed ? response.buildEmbed() : [],
          components: response.buildComponents(),
        }).catch(() => undefined);
      }
      return;
    }

    // 3) Handle crowns pagination
    if (!customId.startsWith('crowns-page:')) return;

    // crowns-page:action:callerDiscordId:targetDiscordId:viewType:page
    const parts = customId.split(':');
    if (parts.length < 6) return;

    const action = parts[1]!;
    const callerDiscordId = parts[2]!;
    const targetDiscordId = parts[3]!;
    const viewType = parts[4]! as CrownViewType;
    const currentPage = parseInt(parts[5]!, 10) || 1;

    const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!targetUser) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }

    const guildId = interaction.guildId!;
    const crowns = await this.crownService.getUserCrowns(guildId, targetUser.userId, viewType);
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(crowns.length / pageSize));

    let newPage = currentPage;
    if (action === 'first') newPage = 1;
    else if (action === 'prev') newPage = Math.max(1, currentPage - 1);
    else if (action === 'next') newPage = Math.min(totalPages, currentPage + 1);
    else if (action === 'last') newPage = totalPages;
    else if (action === 'jump') newPage = Math.min(totalPages, Math.max(1, Math.floor(totalPages / 2)));

    const member = interaction.guild?.members.cache.get(targetDiscordId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;
    const accentColor = await this.colorService.getAccentColorAsync(guildId);

    const response = CrownBuilders.buildCrownsResponse(
      displayName,
      callerDiscordId,
      targetDiscordId,
      crowns,
      newPage,
      viewType,
      accentColor,
    );

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
