import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import { UserSetting, UserSettingMeta } from '@domain/enums/userSetting';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { ResponseMode } from '@domain/enums/responseMode';
import { CoverType, CoverTypeDescriptions } from '@domain/enums/coverType';

export class UserSettingsBuilders {
  /**
   * Main .settings central hub view (User Settings tab)
   */
  public static buildUserSettingsResponse(
    context: ContextModel,
    user: User,
    isServerAdmin: boolean = false,
    activeTab: 'user' | 'server' = 'user',
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorBlue);

    const displayName = context.discordDisplayName || context.discordUserId;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## tvbot user settings — ${displayName}`),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(user.userNameLastFm)}`;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Connected with Last.fm account [${user.userNameLastFm}](${userUrl}). Use \`/login\` or \`${context.prefix}login\` to change.`,
      ),
    );

    // Dropdown for selecting settings domain
    const settingsMenu = new StringSelectMenuBuilder()
      .setCustomId('user-settings:select')
      .setPlaceholder('Select setting to view or change')
      .setMinValues(1)
      .setMaxValues(1);

    const supportedSettings: UserSetting[] = [
      UserSetting.FmMode,
      UserSetting.WkMode,
      UserSetting.CoverType,
      UserSetting.Localization,
      UserSetting.BotScrobbling,
      UserSetting.CommandShortcuts,
      UserSetting.SpotifyImport,
      UserSetting.OutOfSync,
      UserSetting.DeleteAccount,
    ];

    for (const setting of supportedSettings) {
      const meta = UserSettingMeta[setting];
      if (!meta) continue;
      settingsMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(meta.name)
          .setDescription(meta.description.slice(0, 100))
          .setValue(`us-view-${meta.value}`),
      );
    }

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(settingsMenu);
    container.addActionRowComponents(selectRow);

    // Tab buttons if user has server administration rights
    if (isServerAdmin) {
      container.addSeparatorComponents(new SeparatorBuilder());
      const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('user-settings:tab:user')
          .setLabel('User Settings')
          .setStyle(activeTab === 'user' ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(activeTab === 'user'),
        new ButtonBuilder()
          .setCustomId('user-settings:tab:server')
          .setLabel('Server Settings')
          .setStyle(activeTab === 'server' ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(activeTab === 'server'),
      );
      container.addActionRowComponents(tabRow);
    }

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Fast mode picker (.mode / .md / .customize)
   */
  public static buildModePickResponse(
    _context: ContextModel,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorBlue);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Pick which mode you want to modify'),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    // Section 1: .fm mode
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('**`.fm` mode**\nChanges how your .fm command looks'),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId('user-settings:open:fmmode')
            .setLabel('Customize')
            .setStyle(ButtonStyle.Primary),
        ),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    // Section 2: Response mode
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            '**Response mode**\nChanges default response modes for `WhoKnows` and top list commands',
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId('user-settings:open:responsemode')
            .setLabel('Customize')
            .setStyle(ButtonStyle.Primary),
        ),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    // Section 3: Album cover type
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            '**Album cover type**\nChanges whether album covers animate or always show as still',
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId('user-settings:open:covermode')
            .setLabel('Customize')
            .setStyle(ButtonStyle.Primary),
        ),
    );

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Response mode configurator (.responsemode / .wkmode / .topmode)
   */
  public static buildResponseModeResponse(
    _context: ContextModel,
    user: User,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorBlue);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Configuring your default response modes'),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    // WhoKnows Mode Menu
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**WhoKnows mode**'),
    );
    const wkMenu = new StringSelectMenuBuilder()
      .setCustomId('user-settings:set:wkmode')
      .setPlaceholder('Select WhoKnows mode')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Default')
          .setDescription('Standard rich embed leaderboard')
          .setValue(String(WhoKnowsMode.Default))
          .setDefault(user.whoKnowsMode === WhoKnowsMode.Default || !user.whoKnowsMode),
        new StringSelectMenuOptionBuilder()
          .setLabel('Image')
          .setDescription('Rendered visual graphic image')
          .setValue(String(WhoKnowsMode.Image))
          .setDefault(user.whoKnowsMode === WhoKnowsMode.Image),
        new StringSelectMenuOptionBuilder()
          .setLabel('Pagination')
          .setDescription('Paginated embed with interactive buttons')
          .setValue(String(WhoKnowsMode.Pagination))
          .setDefault(user.whoKnowsMode === WhoKnowsMode.Pagination),
      );
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(wkMenu));

    container.addSeparatorComponents(new SeparatorBuilder());

    // Top List Mode Menu
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**Top list mode**'),
    );
    const topMenu = new StringSelectMenuBuilder()
      .setCustomId('user-settings:set:topmode')
      .setPlaceholder('Select top list mode')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Embed')
          .setDescription('Rich interactive text embed with pages')
          .setValue(String(ResponseMode.Embed))
          .setDefault(user.mode === ResponseMode.Embed || !user.mode),
        new StringSelectMenuOptionBuilder()
          .setLabel('Image')
          .setDescription('Generated visual chart image')
          .setValue(String(ResponseMode.Image))
          .setDefault(user.mode === ResponseMode.Image),
      );
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(topMenu));

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# You can also override this on any command by adding `image` / `img` or `embed`.',
      ),
    );

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Album cover type configurator (.covermode / .covertype)
   */
  public static buildCoverModeResponse(
    _context: ContextModel,
    user: User,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorBlue);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Set your preferred album cover type'),
    );
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Choose whether the `cover` command shows animated covers when available or always the still image. You can still toggle per-cover with buttons.',
      ),
    );

    const coverMenu = new StringSelectMenuBuilder()
      .setCustomId('user-settings:set:covertype')
      .setPlaceholder('Set your preferred album cover type')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Motion')
          .setDescription(CoverTypeDescriptions[CoverType.Motion])
          .setValue(String(CoverType.Motion))
          .setDefault(user.coverType === CoverType.Motion || !user.coverType),
        new StringSelectMenuOptionBuilder()
          .setLabel('Still')
          .setDescription(CoverTypeDescriptions[CoverType.Still])
          .setValue(String(CoverType.Still))
          .setDefault(user.coverType === CoverType.Still),
      );
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(coverMenu));

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Localization info (.localization explanation)
   */
  public static buildLocalizationResponse(
    _context: ContextModel,
    user: User,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorBlue);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Localization Settings'),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    const tz = user.timeZone ?? 'UTC';
    const nf = user.numberFormat ?? 'comma';

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Current Timezone:** \`${tz}\`\n` +
        `**Current Number Format:** \`${nf}\`\n\n` +
        'Use the `/localization` command to set your timezone and number formatting for tvbot commands.\n\n' +
        '-# Note: This does not change the localization setting on the Last.fm website.',
      ),
    );

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Self-block confirmation (.selfblock / .selfunblock)
   */
  public static buildSelfBlockResponse(
    guildName: string,
    blocked: boolean,
    prefix: string,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    container.setAccentColor(accentColor ?? DiscordConstants.LastFmColorBlue);

    if (blocked) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### Selfblocked in ${guildName}\n` +
          'You will no longer appear in WhoKnows and server-wide charts in this server.\n' +
          `Run \`${prefix}selfunblock\` here to undo this.`,
        ),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### Selfblock removed in ${guildName}\n` +
          'You will now appear again in WhoKnows and server-wide charts in this server.',
        ),
      );
    }

    response.setComponentsV2Container(container);
    return response;
  }
}
