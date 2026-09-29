import { ButtonInteraction } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { UserHubBuilders } from '@bot/builders/userHubBuilders';

@injectable()
export class UserHubInteractions {
  constructor(
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

      // CORRECT AS IS: the `deferUpdate` is not near a data read.
      // `botScrobblingService.getNowPlaying` below is a synchronous in-memory
      // read, and the opt-in toggle above cannot fail, so there is no genuine
      // failure left for this catch to swallow. What it swallows is only Discord
      // refusing to acknowledge - and since this handler `editReply`s rather than
      // `update`s, a failed ack costs nothing but a slower-looking press.
      // Worth noting the ordering though, because it is the interesting part of
      // this branch - the in-memory opt-in toggle has ALREADY been applied by
      // the line above, and the durable write is the fire-and-forget inside
      // `toggleUserOptIn`. So the state the user is shown below is the state that
      // is actually in effect this session; only durability across a restart
      // depends on the write, exactly as `queueService.saveSettings` documents
      // for guild music prefs.
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
