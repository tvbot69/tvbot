import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { FriendsService } from '@bot/services/friendsService';
import { FriendBuilders, type FriendNowPlayingItem } from '@bot/builders/friendBuilders';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { FriendType } from '@domain/enums/friendType';

export class FriendSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  private readonly userService: UserService;
  private readonly friendsService: FriendsService;
  private readonly lastfmRepository: ILastfmRepository;

  constructor(
    userService: UserService,
    friendsService: FriendsService,
    lastfmRepository: ILastfmRepository,
  ) {
    this.userService = userService;
    this.friendsService = friendsService;
    this.lastfmRepository = lastfmRepository;

    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('friends')
          .setDescription('Manage your Last.fm friends list and view what friends are listening to')
          .addSubcommand((sub) =>
            sub.setName('list').setDescription('Shows what your friends are currently listening to'),
          )
          .addSubcommand((sub) =>
            sub
              .setName('add')
              .setDescription('Add a user to your friends list')
              .addStringOption((opt) =>
                opt.setName('username').setDescription('Last.fm username or Discord mention').setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('remove')
              .setDescription('Remove a user from your friends list')
              .addStringOption((opt) =>
                opt.setName('username').setDescription('Last.fm username or Discord mention').setRequired(true),
              ),
          ),
        executeAsync: (context) => {
          const sub = context.interaction?.options.getSubcommand() || 'list';
          if (sub === 'add') return this.addFriendAsync(context);
          if (sub === 'remove') return this.removeFriendAsync(context);
          return this.friendsFmAsync(context);
        },
      },
    ];
  }

  private async friendsFmAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    const allFriends = await this.friendsService.getFriendsByUserId(user.userId);
    const visibleFriends = allFriends.filter((f) => f.friendType >= FriendType.VisibleInNowPlaying);

    if (allFriends.length === 0 || visibleFriends.length === 0) {
      return FriendBuilders.buildFriendsNowPlayingResponse(context, user, [], allFriends.length);
    }

    const items: FriendNowPlayingItem[] = [];

    await Promise.all(
      visibleFriends.map(async (friend) => {
        const username = friend.friendUser?.userNameLastFm ?? friend.lastFmUserName;
        let displayName = username;

        if (friend.friendUser) {
          const member = context.guild?.members.cache.get(friend.friendUser.discordUserId);
          if (member?.displayName) {
            displayName = member.displayName;
          }
        }

        try {
          const recent = await this.lastfmRepository.getUserRecentTracks(
            username,
            1,
            1,
            undefined,
            friend.friendUser?.sessionKey,
          );

          if (!recent || recent.length === 0) {
            items.push({
              friend,
              displayName,
            });
            return;
          }

          const track = recent[0]!;
          items.push({
            friend,
            displayName,
            trackName: track.name,
            artistName: track.artistName,
            nowPlaying: track.nowPlaying,
            timePlayed: track.timePlayed,
          });
        } catch {
          items.push({
            friend,
            displayName,
            error: 'Could not retrieve tracks',
          });
        }
      }),
    );

    items.sort((a, b) => {
      if (a.nowPlaying && !b.nowPlaying) return -1;
      if (!a.nowPlaying && b.nowPlaying) return 1;
      const timeA = a.timePlayed?.getTime() ?? 0;
      const timeB = b.timePlayed?.getTime() ?? 0;
      if (timeA !== timeB) return timeB - timeA;
      return a.displayName.localeCompare(b.displayName);
    });

    return FriendBuilders.buildFriendsNowPlayingResponse(context, user, items, allFriends.length);
  }

  private async addFriendAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    const rawUsername = context.interaction?.options.getString('username')?.trim();
    if (!rawUsername) {
      return GenericEmbedService.buildWrongInputResponse('Please specify a username.');
    }

    let targetUsername = rawUsername.replace(/[<@!>]/g, '').trim();
    if (/^\d{17,20}$/.test(targetUsername)) {
      const targetUser = await this.userService.getUserByDiscordId(targetUsername);
      if (targetUser) targetUsername = targetUser.userNameLastFm;
    }

    const existingFriends = await this.friendsService.getFriendsByUserId(user.userId);
    const match = existingFriends.find((f) => f.lastFmUserName.toLowerCase() === targetUsername.toLowerCase());

    if (match) {
      return FriendBuilders.buildAddFriendsResultResponse(
        context,
        [],
        [],
        [{ name: targetUsername, type: match.friendType, friendId: match.friendId }],
      );
    }

    const lfmInfo = await this.lastfmRepository.getUserInfo(targetUsername);
    if (!lfmInfo) {
      return FriendBuilders.buildAddFriendsResultResponse(context, [], [targetUsername], []);
    }

    const friendId = await this.friendsService.addFriend(
      user,
      targetUsername,
      null,
      FriendType.VisibleInNowPlaying,
    );

    return FriendBuilders.buildAddFriendsResultResponse(
      context,
      [{ name: targetUsername, type: FriendType.VisibleInNowPlaying, friendId }],
      [],
      [],
    );
  }

  private async removeFriendAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register`.');
    }

    const rawUsername = context.interaction?.options.getString('username')?.trim();
    if (!rawUsername) {
      return GenericEmbedService.buildWrongInputResponse('Please specify a username.');
    }

    let targetUsername = rawUsername.replace(/[<@!>]/g, '').trim();
    if (/^\d{17,20}$/.test(targetUsername)) {
      const targetUser = await this.userService.getUserByDiscordId(targetUsername);
      if (targetUser) targetUsername = targetUser.userNameLastFm;
    }

    const ok = await this.friendsService.removeFriendByLfm(user.userId, targetUsername);
    if (ok) {
      return FriendBuilders.buildRemoveFriendsResultResponse([targetUsername], [], context.accentColor);
    }
    return FriendBuilders.buildRemoveFriendsResultResponse([], [targetUsername], context.accentColor);
  }
}
