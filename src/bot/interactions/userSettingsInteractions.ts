import {
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  MessageFlags,
  type Interaction,
} from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { UserService } from '@bot/services/userService';
import { FmSettingService } from '@bot/services/fmSettingService';
import { UserSettingsBuilders } from '@bot/builders/userSettingsBuilders';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { ContextModel } from '@bot/models/contextModel';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { ResponseMode, ResponseModeNames } from '@domain/enums/responseMode';
import { CoverType, CoverTypeNames } from '@domain/enums/coverType';
import { buildSettingsPage } from './settingsInteractions';
import { PrefixService } from '@bot/services/prefixService';

export const USER_SETTINGS_PREFIX = 'user-settings:';

@injectable()
export class UserSettingsInteractions {
  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(FmSettingService) private readonly fmSettingService: FmSettingService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
  ) {}

  public isUserSettingsInteraction(interaction: Interaction): boolean {
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      return (
        interaction.customId.startsWith(USER_SETTINGS_PREFIX) ||
        interaction.customId === 'response-mode-pick' ||
        interaction.customId === 'cover-type-pick'
      );
    }
    return false;
  }

  public async handle(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({
        content: 'You need to register your Last.fm account with `/login` or `.login` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const context = ContextModel.fromComponentInteraction(interaction);

    if (interaction.isStringSelectMenu()) {
      await this.handleSelectMenu(interaction, context, user);
    } else if (interaction.isButton()) {
      await this.handleButton(interaction, context, user);
    }
  }

  private async handleSelectMenu(
    interaction: StringSelectMenuInteraction,
    context: ContextModel,
    user: import('@domain/interfaces/iuserRepository').User,
  ): Promise<void> {
    const customId = interaction.customId;
    const selectedValue = interaction.values[0];

    // Main dropdown on .settings
    if (customId === 'user-settings:select') {
      const settingKey = selectedValue?.replace('us-view-', '');

      switch (settingKey) {
        case 'FmMode': {
          const setting = (await this.fmSettingService.get(user.userId)) ?? {
            embedType: 0,
            footerOptions: 16n,
            buttons: 0n,
            smallTextType: null,
          };
          const res = PlayBuilders.buildFmModeResponse(setting, context.accentColor);
          await interaction.reply({
            components: res.componentsV2Container ? [res.componentsV2Container] : [],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
          break;
        }
        case 'WkMode': {
          const res = UserSettingsBuilders.buildResponseModeResponse(context, user);
          await interaction.reply({
            components: res.componentsV2Container ? [res.componentsV2Container] : [],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
          break;
        }
        case 'CoverType': {
          const res = UserSettingsBuilders.buildCoverModeResponse(context, user);
          await interaction.reply({
            components: res.componentsV2Container ? [res.componentsV2Container] : [],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
          break;
        }
        case 'Localization': {
          const res = UserSettingsBuilders.buildLocalizationResponse(context, user);
          await interaction.reply({
            components: res.componentsV2Container ? [res.componentsV2Container] : [],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
          break;
        }
        case 'BotScrobbling': {
          await interaction.reply({
            content: 'Music bot scrobbling: use `.botscrobbling` to view and configure auto-scrobbling when listening via voice bots.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        case 'CommandShortcuts': {
          await interaction.reply({
            content: 'Command shortcuts: use `.shortcuts` to view and define custom command aliases.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        case 'SpotifyImport': {
          await interaction.reply({
            content: 'Spotify & Apple Music imports: use `.spotifyimport` or `.appleimport` to import your streaming history.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        case 'OutOfSync': {
          await interaction.reply({
            content:
              '**Out of sync?**\n' +
              'If Spotify and Last.fm become out of sync, try disconnecting and reconnecting Spotify scrobbling on your Last.fm Applications settings page:\n' +
              'https://www.last.fm/settings/applications',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        case 'DeleteAccount': {
          await interaction.reply({
            content:
              'To delete your tvbot account and clear all indexed data, run `.deleteaccount` or contact the server administrator.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        default: {
          await interaction.reply({
            content: 'Unknown setting selected.',
            flags: MessageFlags.Ephemeral,
          });
        }
      }
      return;
    }

    // Set WhoKnows Mode
    if (customId === 'user-settings:set:wkmode') {
      const modeNum = Number(selectedValue) || WhoKnowsMode.Default;
      await this.userService.setWhoKnowsMode(user.userId, modeNum);
      const modeName = modeNum === WhoKnowsMode.Image ? 'Image' : modeNum === WhoKnowsMode.Pagination ? 'Pagination' : 'Default';
      await interaction.reply({
        content: `Your default WhoKnows mode has been set to **${modeName}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Set Top list Mode
    if (customId === 'user-settings:set:topmode') {
      const modeNum = Number(selectedValue) || ResponseMode.Embed;
      await this.userService.setResponseMode(user.userId, modeNum);
      const modeName = ResponseModeNames[modeNum as ResponseMode] ?? 'Embed';
      await interaction.reply({
        content: `Your default Top list mode has been set to **${modeName}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Set Cover Type
    if (customId === 'user-settings:set:covertype') {
      const typeNum = Number(selectedValue) || CoverType.Motion;
      await this.userService.setCoverType(user.userId, typeNum);
      const typeName = CoverTypeNames[typeNum as CoverType] ?? 'Motion';
      await interaction.reply({
        content: `Your default album cover type has been set to **${typeName}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  private async handleButton(
    interaction: ButtonInteraction,
    context: ContextModel,
    user: import('@domain/interfaces/iuserRepository').User,
  ): Promise<void> {
    const customId = interaction.customId;

    if (customId === 'user-settings:open:fmmode') {
      const setting = (await this.fmSettingService.get(user.userId)) ?? {
        embedType: 0,
        footerOptions: 16n,
        buttons: 0n,
        smallTextType: null,
      };
      const res = PlayBuilders.buildFmModeResponse(setting, context.accentColor);
      await interaction.reply({
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (customId === 'user-settings:open:responsemode' || customId === 'response-mode-pick') {
      const res = UserSettingsBuilders.buildResponseModeResponse(context, user);
      await interaction.reply({
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (customId === 'user-settings:open:covermode' || customId === 'cover-type-pick') {
      const res = UserSettingsBuilders.buildCoverModeResponse(context, user);
      await interaction.reply({
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (customId === 'user-settings:tab:user') {
      const isServerAdmin = context.userIsGuildAdmin;
      const res = UserSettingsBuilders.buildUserSettingsResponse(context, user, isServerAdmin, 'user');
      await interaction.update({
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (customId === 'user-settings:tab:server') {
      const res = await buildSettingsPage(context, this.prefixService);
      await interaction.update({
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }
  }
}
