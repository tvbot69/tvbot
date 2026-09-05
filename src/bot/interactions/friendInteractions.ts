import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { inject, injectable } from 'tsyringe';
import { FriendsService } from '@bot/services/friendsService';
import { UserService } from '@bot/services/userService';
import { FriendBuilders } from '@bot/builders/friendBuilders';
import { FriendType, FriendTypeDescriptions, FriendTypeNames } from '@domain/enums/friendType';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { Logger } from '@domain/logger';
import { ContextModel } from '@bot/models/contextModel';

import { ColorService } from '@bot/services/colorService';

export const FRIEND_BUTTON_PREFIXES = ['friends:overview', 'friends:manage', 'friends:settype', 'friends:delete'];

@injectable()
export class FriendInteractions {
  private readonly friendsService: FriendsService;
  private readonly userService: UserService;
  private readonly colorService: ColorService;

  constructor(
    @inject(FriendsService) friendsService: FriendsService,
    @inject(UserService) userService: UserService,
    @inject(ColorService) colorService: ColorService,
  ) {
    this.friendsService = friendsService;
    this.userService = userService;
    this.colorService = colorService;
  }

  private async buildContext(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<ContextModel> {
    const context = new ContextModel();
    context.discordUserId = interaction.user.id;
    context.guildId = interaction.guildId ?? undefined;
    context.prefix = '.';
    context.accentColor = await this.colorService.getAccentColorAsync(interaction.user.id);
    return context;
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    try {
      if (customId.startsWith('friends:overview')) {
        await this.handleOverview(interaction);
      } else if (customId.startsWith('friends:manage:')) {
        await this.handleManageMenu(interaction);
      } else if (customId.startsWith('friends:delete:')) {
        await this.handleDelete(interaction);
      }
    } catch (err) {
      Logger.error({ err }, `Error handling friend button interaction: ${customId}`);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong processing this interaction.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  }

  public async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;

    try {
      if (customId.startsWith('friends:selecttype:')) {
        await this.handleSelectType(interaction);
      }
    } catch (err) {
      Logger.error({ err }, `Error handling friend select interaction: ${customId}`);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong processing this interaction.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  }

  private async handleOverview(interaction: ButtonInteraction): Promise<void> {
    // friends:overview:<page>
    const parts = interaction.customId.split(':');
    const pageIndex = Number(parts[2]) || 0;

    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({ content: 'You have not registered your Last.fm username yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    const context = await this.buildContext(interaction);
    const response = FriendBuilders.buildManageFriendsResponse(context, friends, pageIndex);

    if (response.componentsV2Container) {
      await interaction.editReply({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }

  private async handleManageMenu(interaction: ButtonInteraction): Promise<void> {
    // friends:manage:<friendId>:<page>
    const parts = interaction.customId.split(':');
    const friendId = Number(parts[2]);
    const pageIndex = Number(parts[3]) || 0;

    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({ content: 'You have not registered your Last.fm username yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    const friend = await this.friendsService.getFriend(friendId);
    if (!friend || friend.userId !== user.userId) {
      await interaction.reply({ content: 'Friend record not found or you do not have permission.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    const username = friend.friendUser?.userNameLastFm ?? friend.lastFmUserName;
    const accentColor = await this.colorService.getAccentColorAsync(interaction.user.id);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### Edit Friend: **${username}**\nCurrent type: **${FriendTypeNames[friend.friendType]}**\nSelect a new type or remove this friend:`,
      ),
    );

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`friends:selecttype:${friendId}:${pageIndex}`)
      .setPlaceholder('Choose friend type')
      .addOptions([
        {
          label: '👥 Normal',
          description: FriendTypeDescriptions[FriendType.Normal],
          value: String(FriendType.Normal),
          default: friend.friendType === FriendType.Normal,
        },
        {
          label: '👁️ Visible everywhere',
          description: FriendTypeDescriptions[FriendType.VisibleInNowPlaying],
          value: String(FriendType.VisibleInNowPlaying),
          default: friend.friendType === FriendType.VisibleInNowPlaying,
        },
        {
          label: '⭐ Close friend',
          description: FriendTypeDescriptions[FriendType.CloseFriend],
          value: String(FriendType.CloseFriend),
          default: friend.friendType === FriendType.CloseFriend,
        },
      ]);

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`friends:overview:${pageIndex}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`friends:delete:${friendId}:${pageIndex}`)
        .setLabel('Remove friend')
        .setStyle(ButtonStyle.Danger),
    );

    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    container.addActionRowComponents(buttonRow);

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  private async handleSelectType(interaction: StringSelectMenuInteraction): Promise<void> {
    // friends:selecttype:<friendId>:<page>
    const parts = interaction.customId.split(':');
    const friendId = Number(parts[2]);
    const pageIndex = Number(parts[3]) || 0;
    const selectedType = Number(interaction.values[0]) as FriendType;

    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({ content: 'You have not registered your Last.fm username yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    await this.friendsService.setFriendType(friendId, selectedType);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    const context = await this.buildContext(interaction);
    const response = FriendBuilders.buildManageFriendsResponse(context, friends, pageIndex);

    if (response.componentsV2Container) {
      await interaction.editReply({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }

  private async handleDelete(interaction: ButtonInteraction): Promise<void> {
    // friends:delete:<friendId>:<page>
    const parts = interaction.customId.split(':');
    const friendId = Number(parts[2]);
    const pageIndex = Number(parts[3]) || 0;

    const user = await this.userService.getUserByDiscordId(interaction.user.id);
    if (!user) {
      await interaction.reply({ content: 'You have not registered your Last.fm username yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    await this.friendsService.removeFriend(friendId);

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    const context = await this.buildContext(interaction);
    const response = FriendBuilders.buildManageFriendsResponse(context, friends, pageIndex);

    if (response.componentsV2Container) {
      await interaction.editReply({
        components: [response.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }
}
