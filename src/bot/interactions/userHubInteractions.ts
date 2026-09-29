import { ButtonInteraction } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { AiJudgeService, type JudgeMode } from '@bot/services/aiJudgeService';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { UserHubBuilders } from '@bot/builders/userHubBuilders';
import { TimePeriod } from '@domain/enums/timePeriod';

@injectable()
export class UserHubInteractions {
  constructor(
    @inject(AiJudgeService) private readonly aiJudgeService: AiJudgeService,
    @inject(BotScrobblingService) private readonly botScrobblingService: BotScrobblingService,
    @inject(UserService) private readonly userService: UserService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('userhub:')) return;

    const accentColor = interaction.guildId && this.colorService
      ? await this.colorService.getAccentColorAsync(interaction.guildId)
      : null;

    if (customId.startsWith('userhub:judge:')) {
      const parts = customId.split(':');
      const mode = (parts[2] as JudgeMode) || 'judge';
      const targetDiscordUserId = parts[3] || interaction.user.id;

      const user = await this.userService.getUserByDiscordId(targetDiscordUserId);
      if (!user) {
        await interaction.reply({
          content: 'Last.fm user details could not be found.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferUpdate().catch(() => undefined);

      // CORRECT AS IS on both `deferUpdate` calls in this file, and neither one
      // is near a data read. `aiJudgeService.evaluateTaste` and
      // `botScrobblingService.getNowPlaying` are called AFTER these lines and
      // have no local catch, so a genuine failure in either propagates to
      // `interactionHandler.onInteractionCreated` and is reported to the presser
      // with a source-named message. What is swallowed here is only Discord
      // refusing to acknowledge - and since the button handlers below `editReply`
      // rather than `update`, a failed ack costs nothing but a slower-looking
      // press.
      const result = await this.aiJudgeService.evaluateTaste({
        userNameLastFm: user.userNameLastFm,
        discordUserId: targetDiscordUserId,
        mode,
        period: TimePeriod.Quarterly,
      });

      const member = interaction.guild?.members.cache.get(targetDiscordUserId);
      const displayName = member?.displayName ?? interaction.user.displayName;

      const response = UserHubBuilders.buildJudgeResponse({
        result,
        displayName,
        accentColor,
      });

      if (response.componentsV2Container) {
        await interaction.editReply({
          components: [response.componentsV2Container],
        });
      }
      return;
    }

    if (customId.startsWith('userhub:botscrobble:')) {
      const parts = customId.split(':');
      const action = parts[2]; // 'enable' | 'disable'

      const user = await this.userService.getUserByDiscordId(interaction.user.id);
      if (!user) {
        await interaction.reply({
          content: 'Please connect your Last.fm account with `/login` first before using bot scrobbling.',
          ephemeral: true,
        });
        return;
      }

      const enable = action === 'enable';
      this.botScrobblingService.toggleUserOptIn(interaction.user.id, enable);

      // CORRECT AS IS, second `deferUpdate`: identical reasoning to the one
      // above. Worth noting the ordering though, because it is the interesting
      // part of this branch - the in-memory opt-in toggle has ALREADY been
      // applied by the line above, and the durable write is the fire-and-forget
      // inside `toggleUserOptIn`. So the state the user is shown below is the
      // state that is actually in effect this session; only durability across a
      // restart depends on the write, exactly as `queueService.saveSettings`
      // documents for guild music prefs.
      await interaction.deferUpdate().catch(() => undefined);

      const nowPlaying = interaction.guildId
        ? this.botScrobblingService.getNowPlaying(interaction.guildId)
        : undefined;

      const response = UserHubBuilders.buildBotScrobblingResponse({
        optedIn: enable,
        nowPlaying,
        accentColor,
      });

      if (response.componentsV2Container) {
        await interaction.editReply({
          components: [response.componentsV2Container],
        });
      }
    }
  }
}
