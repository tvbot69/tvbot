import { container } from 'tsyringe';
import { TextDisplayBuilder } from 'discord.js';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { FriendsService } from '@bot/services/friendsService';
import { FriendBuilders, type FriendNowPlayingItem } from '@bot/builders/friendBuilders';
import { ArtworkService } from '@bot/services/artworkService';
import { ColorService } from '@bot/services/colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { CommandResponse } from '@domain/enums/commandResponse';
import { Logger } from '@domain/logger';
import { toDate } from '@domain/date';
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
        aliases: ['ffm', 'friends'],
        executeAsync: (context) => this.friendsFmAsync(context),
      },
      {
        name: 'addfriends',
        aliases: ['addfriend', 'friend', 'add'],
        executeAsync: (context, args) => this.addFriendsAsync(context, args),
      },
      {
        name: 'removefriends',
        aliases: ['removefriend', 'unfriend'],
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

    let accentColor = DiscordConstants.LastFmColorRed;
    if (items.length > 0 && items[0]?.artistName && items[0]?.trackName) {
      try {
        const artSvc = container.resolve(ArtworkService);
        const clrSvc = container.resolve(ColorService);
        // Signature is (trackName, artistName) — these were swapped, so the
        // lookup searched for a track named after the artist by an artist
        // named after the track: never matched, five wasted provider calls,
        // and the command always fell back to the red accent.
        const artUrl = await artSvc.getTrackCoverUrl(items[0].trackName, items[0].artistName);
        if (artUrl) {
          accentColor = await clrSvc.getColorFromImageUrl(artUrl);
        }
      } catch {
        // CORRECT AS IS, the twin of the slash-site with the identical comment:
        // `accentColor` already holds the Last.fm red and this read only refines
        // it from the top friend's cover. The friend rows were built and sorted
        // above, so every now-playing track and timestamp on the card is
        // unaffected. Decoration cannot make a number wrong.
        // fallback
      }
    }
    context.accentColor = accentColor;

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
    // Names we could not check, kept apart from `notFound` on purpose. Last.fm
    // being down says nothing about whether these people exist, and reporting
    // them as missing is the exact claim `user.getinfo` raising exists to stop
    // the bot from making.
    const unreachable: string[] = [];

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
      //
      // A Last.fm outage raises rather than returning null, and an escaping
      // throw here would abort the loop AFTER earlier arguments were already
      // written to the database - leaving the user with friends added and no
      // confirmation of it. One bad minute must not lose the result of a
      // multi-add, so the failure is per-argument.
      //
      // BUT per-argument must not become "indistinguishable from not-found".
      // The previous version pushed the name into `notFound`, and the builder
      // renders that list as "Could not find N users on Last.fm" - a confident
      // claim that real people do not exist, made while Last.fm was down and
      // nobody had asked it. They were also silently not added. The loop still
      // runs to completion; the failure is just no longer filed as an absence.
      let lfmInfo;
      try {
        lfmInfo = await this.lastfmRepository.getUserInfo(targetUsername);
      } catch (err) {
        if (isSourceUnavailable(err)) {
          Logger.error({ err, target: targetUsername }, 'addfriends: Last.fm unreachable');
          unreachable.push(targetUsername);
          continue;
        }
        Logger.error({ err, target: targetUsername }, 'addfriends: Last.fm lookup failed');
        notFound.push(targetUsername);
        continue;
      }
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

    const nothingWasChecked =
      added.length === 0 && notFound.length === 0 && alreadyFriends.length === 0;

    if (unreachable.length > 0 && nothingWasChecked) {
      // Every argument went into `unreachable`, so the builder would be handed
      // three empty lists - and it joins those into `''`, which
      // `TextDisplayBuilder.setContent` rejects outright ("Invalid string
      // length"), throwing before the user sees anything. It is not a file this
      // change owns, so the all-empty case is answered here instead: there is
      // genuinely nothing the add-result card has to say.
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Could not check ${unreachable.length} user${unreachable.length === 1 ? '' : 's'} on Last.fm — ` +
          `Last.fm is unreachable right now.\n` +
          `${unreachable.map((n) => `\`${n}\``).join(', ')}\n` +
          '*Nobody was added. This is not a "no such user" answer — try again in a minute.*',
      );
    }

    const response = FriendBuilders.buildAddFriendsResultResponse(context, added, notFound, alreadyFriends);
    if (unreachable.length > 0) {
      // The builder's "Could not find" list is already rendered by this point,
      // and it correctly does not mention the unreachable names. They still
      // have to be accounted for: a bare "Added 1 friend" and silence about
      // the other two is the same lie from the other direction. Appended as a
      // separate line naming them as unchecked, not as missing.
      const names = unreachable.map((n) => `\`${n}\``).join(', ');
      response.componentsV2Container?.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${unreachable.length} user${unreachable.length === 1 ? '' : 's'} could not be checked — Last.fm was unreachable:**\n` +
          `- ${names}\n` +
          `*They were not added. This is not a "no such user" answer — try again in a minute.*`,
        ),
      );
      response.commandResponse = CommandResponse.Error;
    }
    return response;
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

    // A row with no `created` gets NO timestamp clause at all, rather than one
    // built from `new Date()`. That fallback is the last second the row could
    // have been written, so the card said a friendship was added "in a moment"
    // for a row nobody has a date for — a confident claim about a moment that
    // was never recorded. The approach is the one `updateBuilders:38-44` already
    // uses for an unparseable last-scrobble date: parse, and omit the clause
    // when there is nothing to render.
    const lines = friendedBy.map((f) => {
      const adder = f.friendUser?.userNameLastFm ?? f.lastFmUserName;
      const added = toDate(f.created);
      if (!added || Number.isNaN(added.getTime())) {
        return `- **${adder}**`;
      }
      return `- **${adder}** (<t:${Math.floor(added.getTime() / 1000)}:R>)`;
    });

    return GenericEmbedService.buildInfoResponse(
      `**${friendedBy.length} user${friendedBy.length !== 1 ? 's' : ''} have added you as a friend:**\n${lines.join('\n')}`,
    );
  }
}
