import { container } from 'tsyringe';
import {
  Client,
  Events,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { Logger } from '@domain/logger';
import { Statistics } from '@domain/statistics';
import { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { GuildService } from '@bot/services/guild/guildService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { ComponentInteractionTracker } from '@bot/services/componentInteractionTracker';
import { ColorService } from '@bot/services/colorService';
import { UserService } from '@bot/services/userService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { SettingsInteractions, SETTINGS_BUTTON_PREFIX } from '@bot/interactions/settingsInteractions';
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
import { getSlashCommand } from '@bot/slashCommands';
import { getAutoCompleteResponder } from '@bot/autoCompleteHandlers';
import { tryHandleModal } from '@bot/interactions';

export class InteractionHandler {
  private readonly client: Client;
  private readonly guildService: GuildService;
  private readonly disabledChannelService: DisabledChannelService;
  private readonly guildDisabledCommands: GuildDisabledCommandService;
  private readonly channelToggledCommands: ChannelToggledCommandService;
  private readonly componentTracker: ComponentInteractionTracker;
  private readonly colorService: ColorService;
  private readonly userService: UserService;
  private readonly guildUserService: GuildUserService;
  private readonly settingsInteractions: SettingsInteractions;
  private readonly chartInteractions: ChartInteractions;
  private readonly albumInteractions: AlbumInteractions;
  private readonly fmModeInteractions: FmModeInteractions;
  private readonly friendInteractions: FriendInteractions;
  private readonly musicInteractions: MusicInteractions;
  private readonly trackPreviewInteractions: TrackPreviewInteractions;
  private readonly topInteractions: TopInteractions;
  private readonly artistTrackInteractions: ArtistTrackInteractions;
  private readonly artistInteractions: ArtistInteractions;
  private readonly tasteInteractions: TasteInteractions;
  private readonly recentInteractions: RecentInteractions;
  private readonly crownInteractions: CrownInteractions;
  private readonly footballInteractions: FootballInteractions;
  private readonly playcountInteractions: PlaycountInteractions;
  private readonly profileInteractions: ProfileInteractions;
  private readonly librarySearchInteractions: LibrarySearchInteractions;
  private readonly serverInteractions: ServerInteractions;
  private readonly genreInteractions: GenreInteractions;
  private readonly countryInteractions: CountryInteractions;
  private readonly gameInteractions: GameInteractions;
  private readonly userHubInteractions: UserHubInteractions;
  private readonly intelligenceInteractions: IntelligenceInteractions;

  constructor() {
    this.client = container.resolve(Client);
    this.guildService = container.resolve(GuildService);
    this.disabledChannelService = container.resolve(DisabledChannelService);
    this.guildDisabledCommands = container.resolve(GuildDisabledCommandService);
    this.channelToggledCommands = container.resolve(ChannelToggledCommandService);
    this.componentTracker = container.resolve(ComponentInteractionTracker);
    this.colorService = container.resolve(ColorService);
    this.userService = container.resolve(UserService);
    this.guildUserService = container.resolve(GuildUserService);
    this.settingsInteractions = container.resolve(SettingsInteractions);
    this.chartInteractions = container.resolve(ChartInteractions);
    this.albumInteractions = container.resolve(AlbumInteractions);
    this.fmModeInteractions = container.resolve(FmModeInteractions);
    this.friendInteractions = container.resolve(FriendInteractions);
    this.musicInteractions = container.resolve(MusicInteractions);
    this.trackPreviewInteractions = container.resolve(TrackPreviewInteractions);
    this.topInteractions = container.resolve(TopInteractions);
    this.artistTrackInteractions = container.resolve(ArtistTrackInteractions);
    this.artistInteractions = container.resolve(ArtistInteractions);
    this.tasteInteractions = container.resolve(TasteInteractions);
    this.recentInteractions = container.resolve(RecentInteractions);
    this.crownInteractions = container.resolve(CrownInteractions);
    this.footballInteractions = container.resolve(FootballInteractions);
    this.playcountInteractions = container.resolve(PlaycountInteractions);
    this.profileInteractions = container.resolve(ProfileInteractions);
    this.librarySearchInteractions = container.resolve(LibrarySearchInteractions);
    this.serverInteractions = container.resolve(ServerInteractions);
    this.genreInteractions = container.resolve(GenreInteractions);
    this.countryInteractions = container.resolve(CountryInteractions);
    this.gameInteractions = container.resolve(GameInteractions);
    this.userHubInteractions = container.resolve(UserHubInteractions);
    this.intelligenceInteractions = container.resolve(IntelligenceInteractions);

    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteractionCreated(interaction);
    });
  }

  private async onInteractionCreated(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.executeSlashCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isAnySelectMenu()) {
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
      }
      if (interaction.isButton()) {
        const btnStart = Date.now();
        Logger.button({
          customId: interaction.customId,
          userName: interaction.user.tag ?? interaction.user.username,
          guildName: interaction.guild?.name,
          durationMs: Date.now() - btnStart,
        });

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

    const blocked = await this.isBlockedInContext(
      interaction.guildId,
      interaction.channelId,
      commandName,
    );
    if (blocked) {
      await interaction.reply({ content: blocked, ephemeral: true }).catch(() => undefined);
      return;
    }

    const command = getSlashCommand(commandName);
    if (!command) {
      return;
    }

    if (command.ephemeral) {
      await interaction
        .deferReply({ flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    } else {
      await interaction.deferReply().catch(() => undefined);
    }

    void this.trackActivity(interaction);

    const context = ContextModel.fromInteraction(interaction);
    context.accentColor = await this.colorService.getAccentColorAsync(context.discordUserId)
      ?? (context.guildId ? await this.colorService.getAccentColorAsync(context.guildId) : undefined);

    let typingInterval: NodeJS.Timeout | null = null;
    if (!command.ephemeral && interaction.channel && 'sendTyping' in interaction.channel) {
      void (interaction.channel as unknown as { sendTyping?: () => Promise<void> }).sendTyping?.().catch(() => undefined);
      typingInterval = setInterval(() => {
        void (interaction.channel as unknown as { sendTyping?: () => Promise<void> }).sendTyping?.().catch(() => undefined);
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

      if (response.commandResponse === CommandResponse.Deleted) {
        return;
      }
      await this.sendResponse(interaction, response);
    } catch (err) {
      Logger.error({ err }, `Error executing slash command /${commandName}`);
      const errorResponse = GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Something went wrong while executing that command.',
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
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to send interaction response');
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
