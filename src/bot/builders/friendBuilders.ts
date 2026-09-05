import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { Friend, User } from '@persistence/domain/models/user';
import { FriendType, FriendTypeNames } from '@domain/enums/friendType';
import { DiscordConstants } from '@bot/resources/discordConstants';

const lastfmUserUrl = (userName: string): string =>
  `https://last.fm/user/${encodeURIComponent(userName)}`;

export interface FriendNowPlayingItem {
  friend: Friend;
  displayName: string;
  trackName?: string;
  artistName?: string;
  nowPlaying?: boolean;
  timePlayed?: Date;
  playCount?: number;
  error?: string;
}

export class FriendBuilders {
  public static buildFriendsNowPlayingResponse(
    context: ContextModel,
    user: User,
    items: FriendNowPlayingItem[],
    totalFriends: number,
  ): ResponseModel {
    const response = new ResponseModel(context.accentColor);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    if (context.accentColor !== undefined && context.accentColor !== null) {
      container.setAccentColor(context.accentColor);
    }

    if (items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `You have no visible friends yet. Add friends using \`${context.prefix}addfriend <username>\` or click the button below.`,
        ),
      );
      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('friends:overview:0')
            .setLabel('Manage friends')
            .setStyle(ButtonStyle.Secondary),
        ),
      );
      response.setComponentsV2Container(container);
      return response;
    }

    const title = `### Now playing for friends of ${context.member?.displayName ?? user.userNameLastFm}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(title));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    let totalScrobbles = 0;
    const lines: string[] = [];

    for (const item of items) {
      const username = item.friend.friendUser?.userNameLastFm ?? item.friend.lastFmUserName;
      const nameLink = `**[${item.displayName}](<${lastfmUserUrl(username)}>)**`;

      if (item.error) {
        lines.push(`${nameLink} | *${item.error}*`);
      } else if (item.trackName && item.artistName) {
        let trackText = `${item.trackName} by ${item.artistName}`;
        if (item.nowPlaying) {
          trackText += ' 🎶';
        } else if (item.timePlayed) {
          const timestamp = Math.floor(item.timePlayed.getTime() / 1000);
          trackText += ` (<t:${timestamp}:R>)`;
        }
        lines.push(`${nameLink} | ${trackText}`);
      } else {
        lines.push(`${nameLink} | *No recent scrobbles*`);
      }

      if (item.playCount) {
        totalScrobbles += item.playCount;
      }
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    const footer = `-# Total scrobbles: ${totalScrobbles.toLocaleString()} • Total friends: ${totalFriends}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

    const manageBtn = new ButtonBuilder()
      .setCustomId('friends:overview:0')
      .setLabel('Manage friends')
      .setStyle(ButtonStyle.Secondary);

    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(manageBtn));

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildManageFriendsResponse(
    context: ContextModel,
    friends: Friend[],
    pageIndex: number = 0,
  ): ResponseModel {
    const response = new ResponseModel(context.accentColor);
    response.commandResponse = CommandResponse.Ok;

    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(friends.length / pageSize));
    const safePage = Math.max(0, Math.min(pageIndex, totalPages - 1));

    const pageFriends = friends.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const container = new ContainerBuilder();
    if (context.accentColor !== undefined && context.accentColor !== null) {
      container.setAccentColor(context.accentColor);
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('### 👥 Friends Management'));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    if (friends.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `You have not added any friends yet. Add friends using \`${context.prefix}addfriend <username>\`.`,
        ),
      );
    } else {
      for (const friend of pageFriends) {
        const username = friend.friendUser?.userNameLastFm ?? friend.lastFmUserName;
        const typeBadge = FriendTypeNames[friend.friendType] ?? '👥 Normal';

        const section = new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**[${username}](<${lastfmUserUrl(username)}>)**\n-# ${typeBadge}`,
            ),
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`friends:manage:${friend.friendId}:${safePage}`)
              .setLabel('Edit')
              .setStyle(ButtonStyle.Secondary),
          );

        container.addSectionComponents(section);
      }
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Page ${safePage + 1}/${totalPages} • Total friends: ${friends.length}`,
      ),
    );

    if (totalPages > 1) {
      const prevBtn = new ButtonBuilder()
        .setCustomId(`friends:overview:${safePage - 1}`)
        .setLabel('<')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0);

      const nextBtn = new ButtonBuilder()
        .setCustomId(`friends:overview:${safePage + 1}`)
        .setLabel('>')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1);

      container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn));
    }

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAddFriendsResultResponse(
    context: ContextModel,
    added: Array<{ name: string; type: FriendType; friendId: number }>,
    notFound: string[],
    alreadyFriends: Array<{ name: string; type: FriendType; friendId: number }>,
  ): ResponseModel {
    const response = new ResponseModel(context.accentColor);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    if (context.accentColor !== undefined && context.accentColor !== null) {
      container.setAccentColor(context.accentColor);
    }
    const bodyLines: string[] = [];

    if (added.length > 0) {
      bodyLines.push(`**Added ${added.length} friend${added.length !== 1 ? 's' : ''}:**`);
      for (const a of added) {
        bodyLines.push(`- [${a.name}](<${lastfmUserUrl(a.name)}>) — *${FriendTypeNames[a.type]}*`);
      }
    }

    if (notFound.length > 0) {
      if (bodyLines.length > 0) bodyLines.push('');
      bodyLines.push(`**Could not find ${notFound.length} user${notFound.length !== 1 ? 's' : ''} on Last.fm:**`);
      for (const nf of notFound) {
        bodyLines.push(`- \`${nf}\``);
      }
    }

    if (alreadyFriends.length > 0) {
      if (bodyLines.length > 0) bodyLines.push('');
      bodyLines.push('**Already on your friends list:**');
      for (const af of alreadyFriends) {
        bodyLines.push(`- [${af.name}](<${lastfmUserUrl(af.name)}>) — *${FriendTypeNames[af.type]}*`);
      }
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyLines.join('\n')));

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('friends:overview:0')
        .setLabel('Manage friends')
        .setStyle(ButtonStyle.Secondary),
    );

    if (added.length === 1) {
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`friends:manage:${added[0]!.friendId}:0`)
          .setLabel('Change type')
          .setStyle(ButtonStyle.Secondary),
      );
    }

    container.addActionRowComponents(actionRow);

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildRemoveFriendsResultResponse(
    removed: string[],
    notFound: string[],
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;

    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }
    const bodyLines: string[] = [];

    if (removed.length > 0) {
      bodyLines.push(`**Removed ${removed.length} friend${removed.length !== 1 ? 's' : ''}:**`);
      for (const r of removed) {
        bodyLines.push(`- \`${r}\``);
      }
    }

    if (notFound.length > 0) {
      if (bodyLines.length > 0) bodyLines.push('');
      bodyLines.push('**Not found on your friends list:**');
      for (const nf of notFound) {
        bodyLines.push(`- \`${nf}\``);
      }
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyLines.join('\n')));

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('friends:overview:0')
          .setLabel('Manage friends')
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    response.setComponentsV2Container(container);
    return response;
  }
}
