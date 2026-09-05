import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { FriendsService } from '@bot/services/friendsService';
import { FriendBuilders, type FriendNowPlayingItem } from '@bot/builders/friendBuilders';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { FriendType } from '@domain/enums/friendType';

export class FriendsCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

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
        name: 'friendsfm',
        aliases: ['ffm', 'friends', 'f'],
        executeAsync: (context) => this.friendsFmAsync(context),
      },
      {
        name: 'addfriends',
        aliases: ['addfriend', 'friend', 'add'],
        executeAsync: (context, args) => this.addFriendsAsync(context, args),
      },
      {
        name: 'removefriends',
        aliases: ['removefriend', 'unfriend', 'remove'],
        executeAsync: (context, args) => this.removeFriendsAsync(context, args),
      },
      {
        name: 'removeallfriends',
        executeAsync: (context) => this.removeAllFriendsAsync(context),
      },
      {
        name: 'managefriends',
        executeAsync: (context) => this.manageFriendsAsync(context),
      },
      {
        name: 'friended',
        executeAsync: (context) => this.friendedAsync(context),
      },
    ];
  }

  private async friendsFmAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
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

    // Sort items: nowPlaying first, then by timePlayed desc, then name
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

  private async addFriendsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    if (args.length === 0) {
      return GenericEmbedService.buildWrongInputResponse(`Please specify at least one username: \`${context.prefix}addfriend <username>\``);
    }

    const existingFriends = await this.friendsService.getFriendsByUserId(user.userId);
    const existingLfmSet = new Set(existingFriends.map((f) => f.lastFmUserName.toLowerCase()));

    const added: Array<{ name: string; type: FriendType; friendId: number }> = [];
    const notFound: string[] = [];
    const alreadyFriends: Array<{ name: string; type: FriendType; friendId: number }> = [];

    for (const rawArg of args) {
      let targetUsername = rawArg.replace(/[<@!>]/g, '').trim();

      // If mention, try to look up by discord ID
      if (/^\d{17,20}$/.test(targetUsername)) {
        const targetUser = await this.userService.getUserByDiscordId(targetUsername);
        if (targetUser) {
          targetUsername = targetUser.userNameLastFm;
        }
      }

      if (existingLfmSet.has(targetUsername.toLowerCase())) {
        const match = existingFriends.find((f) => f.lastFmUserName.toLowerCase() === targetUsername.toLowerCase())!;
        alreadyFriends.push({ name: targetUsername, type: match.friendType, friendId: match.friendId });
        continue;
      }

      // Check if user exists on Last.fm
      const lfmInfo = await this.lastfmRepository.getUserInfo(targetUsername);
      if (!lfmInfo) {
        notFound.push(targetUsername);
        continue;
      }

      const friendId = await this.friendsService.addFriend(
        user,
        targetUsername,
        null,
        FriendType.VisibleInNowPlaying,
      );

      added.push({ name: targetUsername, type: FriendType.VisibleInNowPlaying, friendId });
      existingLfmSet.add(targetUsername.toLowerCase());
    }

    return FriendBuilders.buildAddFriendsResultResponse(context, added, notFound, alreadyFriends);
  }

  private async removeFriendsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    if (args.length === 0) {
      return GenericEmbedService.buildWrongInputResponse(`Please specify at least one username: \`${context.prefix}removefriend <username>\``);
    }

    const removed: string[] = [];
    const notFound: string[] = [];

    for (const rawArg of args) {
      let targetUsername = rawArg.replace(/[<@!>]/g, '').trim();
      if (/^\d{17,20}$/.test(targetUsername)) {
        const targetUser = await this.userService.getUserByDiscordId(targetUsername);
        if (targetUser) targetUsername = targetUser.userNameLastFm;
      }

      const ok = await this.friendsService.removeFriendByLfm(user.userId, targetUsername);
      if (ok) {
        removed.push(targetUsername);
      } else {
        notFound.push(targetUsername);
      }
    }

    return FriendBuilders.buildRemoveFriendsResultResponse(removed, notFound, context.accentColor);
  }

  private async removeAllFriendsAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    const count = await this.friendsService.removeAllFriends(user.userId);
    return GenericEmbedService.buildSuccessResponse(`Removed **${count}** friend${count !== 1 ? 's' : ''} from your friends list.`);
  }

  private async manageFriendsAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    const friends = await this.friendsService.getFriendsByUserId(user.userId);
    return FriendBuilders.buildManageFriendsResponse(context, friends, 0);
  }

  private async friendedAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildNotFoundResponse('You need to set your Last.fm username first. Use `/register` or `.register`.');
    }

    const friendedBy = await this.friendsService.getFriended(user.userId);
    if (friendedBy.length === 0) {
      return GenericEmbedService.buildInfoResponse('Nobody has added you to their friends list yet.');
    }

    const lines = friendedBy.map(
      (f) => `- **${f.friendUser?.userNameLastFm ?? f.lastFmUserName}** (<t:${Math.floor((f.created ?? new Date()).getTime() / 1000)}:R>)`,
    );

    return GenericEmbedService.buildInfoResponse(
      `**${friendedBy.length} user${friendedBy.length !== 1 ? 's' : ''} have added you as a friend:**\n${lines.join('\n')}`,
    );
  }
}
