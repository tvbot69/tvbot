import { container, inject, injectable } from 'tsyringe';
import {
  Client,
  Events,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { Logger } from '@domain/logger';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { isLastFmUnavailable } from '@domain/models/lastfmUnavailableError';
import { Statistics } from '@domain/statistics';
import { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { GuildService } from '@bot/services/guild/guildService';
import type { ComponentPaginatorSession } from '@bot/services/componentPaginatorService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { ComponentInteractionTracker } from '@bot/services/componentInteractionTracker';
import { ComponentPaginatorService } from '@bot/services/componentPaginatorService';
import { ColorService } from '@bot/services/colorService';
import { UserService } from '@bot/services/userService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { SettingsInteractions, SETTINGS_BUTTON_PREFIX } from '@bot/interactions/settingsInteractions';
import { UserSettingsInteractions } from '@bot/interactions/userSettingsInteractions';
import { ChartInteractions } from '@bot/interactions/chartInteractions';
import { AlbumInteractions, ALBUM_BUTTON_PREFIXES } from '@bot/interactions/albumInteractions';
import { FmModeInteractions, FM_MODE_PREFIX } from '@bot/interactions/fmModeInteractions';
import { FriendInteractions, FRIEND_BUTTON_PREFIXES } from '@bot/interactions/friendInteractions';
import { MusicInteractions, MUSIC_INTERACTION_PREFIXES } from '@bot/interactions/musicInteractions';
import { TrackPreviewInteractions, TRACK_PREVIEW_PREFIX } from '@bot/interactions/trackPreviewInteractions';
import { TopInteractions } from '@bot/interactions/topInteractions';
import { ArtistTrackInteractions } from '@bot/interactions/artistTrackInteractions';
import { ArtistInteractions } from '@bot/interactions/artistInteractions';
import { TasteInteractions } from '@bot/interactions/tasteInteractions';
import { RecentInteractions } from '@bot/interactions/recentInteractions';
import { CrownInteractions } from '@bot/interactions/crownInteractions';
import { FootballInteractions } from '@bot/interactions/footballInteractions';
import { PlaycountInteractions } from '@bot/interactions/playcountInteractions';
import { ProfileInteractions } from '@bot/interactions/profileInteractions';
import { LibrarySearchInteractions } from '@bot/interactions/librarySearchInteractions';
import { ServerInteractions } from '@bot/interactions/serverInteractions';
import { GenreInteractions } from '@bot/interactions/genreInteractions';
import { CountryInteractions } from '@bot/interactions/countryInteractions';
import { GameInteractions } from '@bot/interactions/gameInteractions';
import { UserHubInteractions } from '@bot/interactions/userHubInteractions';
import { IntelligenceInteractions } from '@bot/interactions/intelligenceInteractions';
import { NowPlayingInteractions } from '@bot/interactions/nowPlayingInteractions';
import { HelpInteractions } from '@bot/interactions/helpInteractions';
import { TelemetryService } from '@bot/services/telemetryService';
import { RateLimitService } from '@bot/services/rateLimitService';
import { getSlashCommand } from '@bot/slashCommands';
import { getAutoCompleteResponder } from '@bot/autoCompleteHandlers';
import { tryHandleModal } from '@bot/interactions';

@injectable()
export class InteractionHandler {

  constructor(
    @inject(Client)
    private readonly client: Client,
    @inject(HelpInteractions)
    private readonly helpInteractions: HelpInteractions,
    @inject(NowPlayingInteractions)
    private readonly nowPlayingInteractions: NowPlayingInteractions,
    @inject(UserSettingsInteractions)
    private readonly userSettingsInteractions: UserSettingsInteractions,
    @inject(GuildService)
    private readonly guildService: GuildService,
    @inject(DisabledChannelService)
    private readonly disabledChannelService: DisabledChannelService,
    @inject(GuildDisabledCommandService)
    private readonly guildDisabledCommands: GuildDisabledCommandService,
    @inject(ChannelToggledCommandService)
    private readonly channelToggledCommands: ChannelToggledCommandService,
    @inject(ComponentInteractionTracker)
    private readonly componentTracker: ComponentInteractionTracker,
    @inject(ComponentPaginatorService)
    private readonly componentPaginatorService: ComponentPaginatorService,
    @inject(ColorService)
    private readonly colorService: ColorService,
    @inject(UserService)
    private readonly userService: UserService,
    @inject(GuildUserService)
    private readonly guildUserService: GuildUserService,
    @inject(SettingsInteractions)
    private readonly settingsInteractions: SettingsInteractions,
    @inject(ChartInteractions)
    private readonly chartInteractions: ChartInteractions,
    @inject(AlbumInteractions)
    private readonly albumInteractions: AlbumInteractions,
    @inject(FmModeInteractions)
    private readonly fmModeInteractions: FmModeInteractions,
    @inject(FriendInteractions)
    private readonly friendInteractions: FriendInteractions,
    @inject(MusicInteractions)
    private readonly musicInteractions: MusicInteractions,
    @inject(TrackPreviewInteractions)
    private readonly trackPreviewInteractions: TrackPreviewInteractions,
    @inject(TopInteractions)
    private readonly topInteractions: TopInteractions,
    @inject(ArtistTrackInteractions)
    private readonly artistTrackInteractions: ArtistTrackInteractions,
    @inject(ArtistInteractions)
    private readonly artistInteractions: ArtistInteractions,
    @inject(TasteInteractions)
    private readonly tasteInteractions: TasteInteractions,
    @inject(RecentInteractions)
    private readonly recentInteractions: RecentInteractions,
    @inject(CrownInteractions)
    private readonly crownInteractions: CrownInteractions,
    @inject(FootballInteractions)
    private readonly footballInteractions: FootballInteractions,
    @inject(PlaycountInteractions)
    private readonly playcountInteractions: PlaycountInteractions,
    @inject(ProfileInteractions)
    private readonly profileInteractions: ProfileInteractions,
    @inject(LibrarySearchInteractions)
    private readonly librarySearchInteractions: LibrarySearchInteractions,
    @inject(ServerInteractions)
    private readonly serverInteractions: ServerInteractions,
    @inject(GenreInteractions)
    private readonly genreInteractions: GenreInteractions,
    @inject(CountryInteractions)
    private readonly countryInteractions: CountryInteractions,
    @inject(GameInteractions)
    private readonly gameInteractions: GameInteractions,
    @inject(UserHubInteractions)
    private readonly userHubInteractions: UserHubInteractions,
    @inject(IntelligenceInteractions)
    private readonly intelligenceInteractions: IntelligenceInteractions,
    @inject(RateLimitService)
    private readonly rateLimitService: RateLimitService,
  ) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteractionCreated(interaction);
    });
  }

  private async onInteractionCreated(interaction: Interaction): Promise<void> {
    let ackGuard: NodeJS.Timeout | undefined;
    try {
      if (interaction.isChatInputCommand()) {
        await this.executeSlashCommand(interaction);
        return;
      }

    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      // Safety net: acknowledge slow components before Discord's 3s interaction
      // window closes. Fast handlers finish first and clear the timer below;
      // only stragglers get auto-deferred (a working follow-up beats a 10062).
      ackGuard = setTimeout(() => {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          void interaction.deferUpdate().catch(() => undefined);
        }
      }, 2500);
      const settingsInteraction = this.userSettingsInteractions.asUserSettingsInteraction(interaction);
      if (settingsInteraction) {
        await this.userSettingsInteractions.handle(settingsInteraction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith(FM_MODE_PREFIX)) {
          await this.fmModeInteractions.handle(interaction);
          return;
        }
        if (interaction.customId.startsWith('friends:selecttype:')) {
          await this.friendInteractions.handleSelectMenu(interaction);
          return;
        }
        if (interaction.customId.startsWith('music:')) {
          await this.musicInteractions.handleSelectMenu(interaction);
          return;
        }
        if (interaction.customId === 'user-crownpicker' || interaction.customId === 'guild-members') {
          await this.crownInteractions.handleSelectMenu(interaction);
          return;
        }
        if (interaction.customId.startsWith('fb:')) {
          await this.footballInteractions.handleSelectMenu(interaction);
          return;
        }
        if (interaction.customId.startsWith('country:theme:')) {
          await this.countryInteractions.handleStringSelect(interaction);
          return;
        }
        if (interaction.customId.startsWith('help:')) {
          await this.helpInteractions.handleSelectMenu(interaction);
          return;
        }
      }
      if (interaction.isButton()) {
        const btnStart = Date.now();
        Logger.button({
          customId: interaction.customId,
          userName: interaction.user.tag ?? interaction.user.username,
          guildName: interaction.guild?.name,
          durationMs: Date.now() - btnStart,
        });

        if (interaction.customId.startsWith('help:')) {
          await this.helpInteractions.handleButton(interaction);
          return;
        }

        if (interaction.customId.startsWith('scrobble-ref:') || interaction.customId.startsWith('scrobble-now:')) {
          await this.nowPlayingInteractions.handleScrobble(interaction);
          return;
        }
        if (interaction.customId.startsWith('love-track:') || interaction.customId.startsWith('unlove-track:')) {
          await this.nowPlayingInteractions.handleLove(interaction);
          return;
        }
        if (interaction.customId.startsWith('loved:')) {
          await this.nowPlayingInteractions.handleLovedPagination(interaction);
          return;
        }
        if (interaction.customId.startsWith('track-lyrics:')) {
          await this.nowPlayingInteractions.handleLyrics(interaction);
          return;
        }
        if (interaction.customId.startsWith(TRACK_PREVIEW_PREFIX)) {
          await this.trackPreviewInteractions.handle(interaction);
          return;
        }
        if (
          interaction.customId.startsWith('artist-overview') ||
          interaction.customId.startsWith('artist-info') ||
          interaction.customId.startsWith('artist-tracks') ||
          interaction.customId.startsWith('artist-albums') ||
          interaction.customId.startsWith('aab:')
        ) {
          await this.artistInteractions.handle(interaction);
          return;
        }
        if (interaction.customId.startsWith('at:')) {
          await this.artistTrackInteractions.handle(interaction);
          return;
        }
        if (interaction.customId.startsWith('top') || interaction.customId.startsWith('overview:')) {
          await this.topInteractions.handle(interaction);
          return;
        }
        if (interaction.customId.startsWith('chart-edit:')) {
          await this.chartInteractions.handleEditButton(interaction);
          return;
        }
        if (interaction.customId.startsWith(SETTINGS_BUTTON_PREFIX)) {
          await this.settingsInteractions.handleSettingsButton(interaction);
          return;
        }
        if (ALBUM_BUTTON_PREFIXES.some((p) => interaction.customId.startsWith(p))) {
          await this.albumInteractions.handleAlbumButton(interaction);
          return;
        }
        if (FRIEND_BUTTON_PREFIXES.some((p) => interaction.customId.startsWith(p))) {
          await this.friendInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('taste-tab:')) {
          await this.tasteInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('recent:')) {
          await this.recentInteractions.handleButton(interaction);
          return;
        }
        if (
          interaction.customId.startsWith('crowns-page:') ||
          interaction.customId.startsWith('artist-whoknows:') ||
          interaction.customId.startsWith('artist-crown:')
        ) {
          await this.crownInteractions.handleButton(interaction);
          return;
        }
        if (MUSIC_INTERACTION_PREFIXES.some((p) => interaction.customId.startsWith(p))) {
          await this.musicInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('fb:')) {
          await this.footballInteractions.handleButton(interaction);
          return;
        }
        if (
          interaction.customId.startsWith('affinity-page:') ||
          interaction.customId.startsWith('discoveries-page:') ||
          interaction.customId.startsWith('gaps-page:')
        ) {
          await this.intelligenceInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('milestone:reroll:')) {
          await this.playcountInteractions.handleButton(interaction);
          return;
        }
        if (
          interaction.customId.startsWith('profile:history:') ||
          interaction.customId.startsWith('profile:view:')
        ) {
          await this.profileInteractions.handleButton(interaction);
          return;
        }
        if (
          interaction.customId.startsWith('search:page:') ||
          interaction.customId.startsWith('search:tab:')
        ) {
          await this.librarySearchInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('server:page:')) {
          await this.serverInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('genre:')) {
          await this.genreInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('country:')) {
          await this.countryInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('game:')) {
          await this.gameInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('userhub:')) {
          await this.userHubInteractions.handleButton(interaction);
          return;
        }
        if (interaction.customId.startsWith('component_paginator_')) {
          await this.componentPaginatorService.handleButton(interaction);
          return;
        }
      }
      const handled = await this.componentTracker.handle(interaction);
      if (!handled && interaction.isRepliable() && !interaction.replied) {
        await interaction
          .reply({ content: 'This interaction expired.', flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      }
      return;
    }

      if (interaction.isModalSubmit()) {
        await tryHandleModal(interaction);
      }
    } catch (err) {
      Logger.error({ err }, 'Unhandled exception in interactionHandler');
      if (interaction.isRepliable() && !interaction.replied) {
        // `deferred` is NOT an answer, and gating on it made the gate defeat the
        // fix that relies on it. Every paginator and nav button calls
        // `deferUpdate()` BEFORE it reads anything - precisely so the press has
        // a visible acknowledgement while a slow source is consulted - so the
        // one case that most needed a reply (a press that failed halfway
        // through) was the one case that got silence. `followUp` is the correct
        // verb once deferred.
        //
        // A deliberate source failure also gets a message that names itself.
        // `LastFmUnavailableError` is re-parented onto `SourceUnavailableError`,
        // so this one check separates "the database is down, retry" from
        // "something is wrong, report it", and a defect still reads as a defect.
        const sourceDown = isSourceUnavailable(err);
        const content = sourceDown
          ? `Could not reach ${isLastFmUnavailable(err) ? 'Last.fm' : 'the database'}. Please try again in a moment.`
          : 'Sorry, something went wrong while processing this interaction.';
        const flags = MessageFlags.Ephemeral;
        await (interaction.deferred
          ? interaction.followUp({ content, flags })
          : interaction.reply({ content, flags })
        ).catch(() => undefined);
      }
    } finally {
      if (ackGuard) clearTimeout(ackGuard);
    }
  }

  private async handleAutocomplete(
    interaction: import('discord.js').AutocompleteInteraction,
  ): Promise<void> {
    const responder = getAutoCompleteResponder(
      interaction.options.getFocused(true).name,
    );
    if (responder) {
      await responder(interaction).catch(() => undefined);
    } else {
      await interaction.respond([]).catch(() => undefined);
    }
  }

  private async executeSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const commandName = interaction.commandName.toLowerCase();
    Statistics.inc('SlashCommandExecuted');

    const command = getSlashCommand(commandName);
    if (!command) {
      // Ack first (below) then report, or Discord shows "This application did
      // not respond" with nothing in the logs.
      await interaction
        .reply({ content: 'That command is no longer available.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      Logger.warn({ commandName }, 'Unrouted slash command');
      return;
    }

    // Acknowledge BEFORE the guard checks. Those are 4 sequential cache/DB
    // reads plus 2-3 Redis round-trips for the rate limit, and Discord's
    // interaction token expires at 3s: with a slow database the interaction
    // was never acknowledged, Discord showed "This interaction failed", and
    // the command then completed into the void — a visible error on a
    // command that actually succeeded. Every path below now edits the
    // deferred reply instead of replying.
    if (command.ephemeral) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      await interaction.deferReply().catch(() => undefined);
    }
    const respond = async (content: string): Promise<void> => {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => undefined);
        return;
      }
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    };

    const blocked = await this.isBlockedInContext(
      interaction.guildId,
      interaction.channelId,
      commandName,
    );
    if (blocked) {
      await respond(blocked);
      return;
    }

    // Same two-tier rate limit as text commands (previously slash was unchecked)
    const rateLimit = await this.rateLimitService.checkUserRateLimitAsync(interaction.user.id);
    if (rateLimit.rateLimited) {
      if (!rateLimit.messageSent) {
        await respond(
          `⏳ You are using commands too fast! Please slow down (${rateLimit.retryAfterSeconds ?? 8}s cooldown).`,
        );
      }
      return;
    }

    void this.trackActivity(interaction);

    const context = ContextModel.fromInteraction(interaction);

    let typingInterval: NodeJS.Timeout | null = null;
    if (!command.ephemeral && interaction.channel && 'sendTyping' in interaction.channel) {
      const channel = interaction.channel as { sendTyping?: () => Promise<void> };
      void channel.sendTyping?.().catch(() => undefined);
      typingInterval = setInterval(() => {
        void channel.sendTyping?.().catch(() => undefined);
      }, 7000);
    }

    const startTime = Date.now();
    try {
      const response = await command.executeAsync(context);
      const durationMs = Date.now() - startTime;
      let subCmd: string | null = null;
      try {
        subCmd = interaction.options.getSubcommand();
      } catch {
        // No subcommand
      }
      Logger.slash({
        commandName,
        subCommand: subCmd,
        userName: interaction.user.tag ?? interaction.user.username,
        guildName: interaction.guild?.name,
        channelName: interaction.channel && 'name' in interaction.channel ? (interaction.channel.name as string) : undefined,
        durationMs,
      });

      try {
        if (container.isRegistered(TelemetryService)) {
          container.resolve(TelemetryService).recordCommandExecution(
            commandName,
            durationMs,
            response.commandResponse !== CommandResponse.Error && response.commandResponse !== CommandResponse.LastFmError,
          );
        }
      } catch {
        // Telemetry should never affect command execution
      }

      if (response.commandResponse === CommandResponse.Deleted) {
        return;
      }
      await this.sendResponse(interaction, response);
    } catch (err) {
      try {
        if (container.isRegistered(TelemetryService)) {
          container.resolve(TelemetryService).recordCommandExecution(commandName, 0, false);
        }
      } catch {
        // Telemetry should never affect command execution
      }

      const { referenceId } = Logger.errorWithRef(err, {
        commandName,
        userName: interaction.user.tag ?? interaction.user.username,
        userId: interaction.user.id,
        guildName: interaction.guild?.name,
        guildId: interaction.guildId,
        shardId: interaction.guild?.shardId ?? 0,
      });
      // Same reasoning as the component catch 150 lines above, and the same
      // reasoning as `CommandDispatcher.handleCommandException`: a source that
      // did not answer is a known, retryable condition, and telling the user
      // "something went wrong, try again later" for it asks them to retry a
      // command that will fail identically. It also collapses a Last.fm
      // outage and a genuine defect into the same sentence, which is the one
      // thing the reference ID is supposed to let a report resolve.
      const apologyText = isSourceUnavailable(err)
        ? `Could not reach ${isLastFmUnavailable(err) ? 'Last.fm' : 'the database'}. Please try again in a moment.\n*Reference ID: \`${referenceId}\`*`
        : `Sorry, something went wrong while executing that command. Please try again later.\n*Reference ID: \`${referenceId}\`\``;
      const errorResponse = GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        apologyText,
      );
      await this.sendResponse(interaction, errorResponse);
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  }

  public async isBlockedInContext(
    guildId: string | null,
    channelId: string | null,
    commandName: string,
  ): Promise<string | null> {
    if (!guildId) {
      return null;
    }

    try {
      const guild = await this.guildService.getGuild(guildId);
      if (guild?.commandsDisabled) {
        return 'Commands are currently disabled in this server.';
      }

      if (await this.disabledChannelService.isChannelDisabled(channelId)) {
        return 'Bot commands are disabled in this channel.';
      }

      if (await this.guildDisabledCommands.isCommandDisabled(guildId, commandName)) {
        return 'This command has been disabled in this server by the staff.';
      }

      if (await this.channelToggledCommands.isCommandToggled(guildId, channelId, commandName)) {
        return 'This command is toggled off in this channel.';
      }
    } catch (err) {
      Logger.warn({ err }, `Error in isBlockedInContext for guild ${guildId}`);
      return null;
    }

    return null;
  }

  private async sendResponse(
    interaction: ChatInputCommandInteraction,
    response: ResponseModel,
  ): Promise<void> {
    const allowedMentions = { parse: [] as string[] };
    let payload: Record<string, unknown>;
    if (response.isComponentsV2) {
      payload = {
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions,
      };
      if (response.hasFile()) {
        payload.files = response.getFiles();
      }
    } else {
      // Support plain content + button responses (trackdetails voice preview) — must send content not embed
      const hasEmbed = response.hasEmbed();
      payload = {
        content: response.content ?? (hasEmbed ? undefined : response._textContent),
        embeds: hasEmbed ? response.buildEmbed() : [],
        components: response.buildComponents(),
        allowedMentions,
      };
      // Mirror embed description to content for trackdetails legacy builder
      if (!payload.content && response._textContent) payload.content = response._textContent;
      if (!hasEmbed && payload.content) delete payload.embeds;
      if (response.hasFile()) {
        payload.files = response.getFiles();
      }
    }
    try {
      let replyMsg: import('discord.js').Message | null = null;
      if (interaction.deferred || interaction.replied) {
        replyMsg = await interaction.editReply(payload);
      } else {
        const reply = await interaction.reply(payload);
        replyMsg = await reply.fetch().catch(() => null);
      }
      if (replyMsg && response._paginatorSession) {
        this.componentPaginatorService.registerSession(replyMsg.id, response._paginatorSession as unknown as ComponentPaginatorSession);
      }
      if (response.autoDeleteSeconds && response.autoDeleteSeconds > 0) {
        const timeoutMs = response.autoDeleteSeconds * 1000;
        setTimeout(() => {
          interaction.deleteReply().catch(() => undefined);
        }, timeoutMs);
      }
    } catch (err) {
      // Never swallow this into silence. A 50035 (invalid form body — every
      // oversize payload), a missing Send Messages, or a 25-component
      // violation all land here, and because the interaction was already
      // deferred the user saw "bot is typing…" and then NOTHING: the visible
      // symptom of every payload bug in this codebase. Say what happened.
      const code = (err as { code?: number })?.code;
      Logger.warn({ err, code, command: interaction.commandName }, 'Failed to send interaction response');
      await interaction
        .followUp({
          content:
            code === 50035
              ? '⚠️ That result was too large to display. Try a shorter search or a smaller page.'
              : '⚠️ I could not display that result. Please try again in a moment.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
  }

  private async trackActivity(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      return;
    }
    try {
      await this.guildService.ensureGuildExists(interaction.guild);
      const user = await this.userService.getUserByDiscordId(interaction.user.id);
      if (user) {
        await this.guildUserService.ensureUserInGuild(interaction.guildId, user.userId);
      }
      await this.guildService.trackLastCommand(interaction.guildId);
    } catch (err) {
      Logger.warn({ err }, 'Failed to track slash command activity');
    }
  }
}