/**
 * `/fm`, `/fmmode`, `/register` - the account surface.
 *
 * `/register` is the sharpest trust boundary in this module, and it is a WRITE.
 * `registerAsync` asks Last.fm whether the username exists, and only then calls
 * `userService.setUserLastFm`. That ordering is the entire feature: a user who
 * types a typo must not end up with a database row pointing at a Last.fm
 * account that does not exist, because every later sync would then report "no
 * scrobbles" for a person who never had any. The tests assert the WRITE did not
 * happen, not merely that an error came back - a handler that returned the
 * error and wrote anyway would pass an enum-only assertion.
 *
 * It also has the two guards before that: an empty username, and the 255
 * character cap, which is Last.fm's own limit. Both must refuse before the
 * network call, or a 300-character paste turns into a lookup and a confusing
 * "could not find" instead of "that is not a username".
 *
 * `/fm` gets the failure-direction treatment. Three separate NotFound branches
 * (unregistered caller, unregistered named target, unregistered Last.fm name)
 * all have to stop before any scrobble is read, and the legacy `lfm:` string
 * grammar has to reach the SAME lookup as the bare name.
 *
 * A NOTE ON DOUBLES. This module resolves `ColorService`, `ArtworkService`,
 * `FmSettingService`, `GuildRepository` and `ChannelRepository` from the tsyringe
 * container rather than taking them as constructor arguments, so those five are
 * registered as plain instances here. Nothing is spied on - the container is
 * never mocked, only populated, and every test re-registers so one test cannot
 * inherit another's double.
 *
 * Constructor arity, read from `userSlashCommands.ts`: userService,
 * lastfmRepository, updateService. Three positional arguments.
 */
import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { UserSlashCommands } from '@bot/slashCommands/user/userSlashCommands';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { FmSettingService } from '@bot/services/system/fmSettingService';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { ChannelRepository } from '@persistence/repositories/channelRepository';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { UpdateService } from '@bot/services/lastfm/updateService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';

const CALLER = {
  userId: 7,
  userNameLastFm: 'DreadRock',
  discordUserId: 'caller1',
  sessionKey: 'sk-abc',
  lastUpdate: new Date(),
  totalPlayCount: 4321,
};

const RECENT_LIST = {
  tracks: [
    {
      name: 'Airbag',
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      imageUrl: 'https://img.test/airbag.jpg',
      nowPlaying: true,
    },
  ],
  totalPages: 4,
  totalScrobbles: 4321,
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return (
      response.componentsV2Container.toJSON() as { components: Array<{ content?: string }> }
    )
      .components.map((c) => c.content ?? '')
      .join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface CtxSpec {
  strings?: Record<string, string | undefined>;
  integers?: Record<string, number | undefined>;
  users?: Record<string, { id: string; username: string }>;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const guild = { id: '222', name: 'Loud Room', members: { cache: { get: () => undefined } } };
  return {
    discordUserId: 'caller1',
    guildId: '222',
    guild,
    member: { displayName: 'Caller' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guild,
      member: { displayName: 'Caller' },
      user: { id: 'caller1', username: 'caller' },
      options: {
        // `getString` THROWS for an option the current builder no longer
        // declares, which is exactly what the legacy `user` slot does; the
        // handler wraps that read in its own try, and this double reproduces it
        // so the wrap is genuinely exercised rather than assumed.
        getString: (name: string) => {
          if (name === 'user') throw new Error(`Required option "user" does not exist.`);
          return spec.strings?.[name] ?? null;
        },
        getInteger: (name: string) => spec.integers?.[name] ?? null,
        getUser: (name: string) => spec.users?.[name] ?? null,
      },
    },
    userIsGuildAdmin: false,
  } as unknown as ContextModel;
};

interface Doubles {
  caller?: unknown;
  byDiscordId?: Record<string, unknown>;
  byLastFmName?: Record<string, unknown>;
  userInfo?: unknown;
  recentTracks?: unknown[];
  recentMetadata?: unknown;
  writeOk?: boolean;
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id];
      return over.caller === undefined ? CALLER : over.caller;
    }),
    getUserByLastFmName: vi.fn(async (name: string) =>
      over.byLastFmName ? (over.byLastFmName[name] ?? null) : null,
    ),
    setUserLastFm: vi.fn(async () => ({ ...CALLER, userNameLastFm: 'written' })),
    enqueueUserUpdate: vi.fn(),
  } as unknown as UserService;
  const lastfmRepository = {
    getUserInfo: vi.fn(async (..._args: unknown[]) => (over.userInfo === undefined ? {} : over.userInfo)),
    getUserRecentTracks: vi.fn(async (..._args: unknown[]) => (over.recentTracks ?? [])),
    getUserRecentTracksWithMetadata: vi.fn(
      async (..._args: unknown[]) => (over.recentMetadata ?? RECENT_LIST),
    ),
  } as unknown as ILastfmRepository;
  const updateService = { updateUser: vi.fn(async () => undefined) } as unknown as UpdateService;

  const cmd = new UserSlashCommands(userService, lastfmRepository, updateService);
  return { cmd, userService, lastfmRepository, updateService };
};

type Handlers = {
  fmAsync(c: ContextModel): Promise<ResponseModel>;
  fmModeAsync(c: ContextModel): Promise<ResponseModel>;
  registerAsync(c: ContextModel): Promise<ResponseModel>;
  recentAsync(c: ContextModel): Promise<ResponseModel>;
};
const h = (cmd: UserSlashCommands) => cmd as unknown as Handlers;

const commandOf = (cmd: UserSlashCommands, name: string) => {
  const found = cmd.commands.find((c) => c.data.toJSON().name === name);
  if (!found) throw new Error(`command ${name} is not registered`);
  return found;
};

beforeEach(() => {
  // Populate, never mock: `container.resolve` is a real code path in this
  // module and stubbing the container would make every one of these tests
  // vacuous.
  container.registerInstance(ColorService, {
    getColorFromImageUrl: vi.fn(async () => 0x445566),
    getAccentColorAsync: vi.fn(async () => 0x445566),
  } as never);
  container.registerInstance(ArtworkService, {
    getAlbumCoverUrl: vi.fn(async () => null),
    getTrackCoverUrl: vi.fn(async () => null),
    getArtistImageUrl: vi.fn(async () => null),
  } as never);
  container.registerInstance(FmSettingService, {
    get: vi.fn(async () => null),
    getOrCreate: vi.fn(async () => ({ embedType: 0, footerOptions: 0n, buttons: 0n, smallTextType: null })),
  } as never);
  container.registerInstance(GuildRepository, { getGuild: vi.fn(async () => null) } as never);
  container.registerInstance(ChannelRepository, { getChannel: vi.fn(async () => null) } as never);
});

describe('/register: a username Last.fm does not have must never reach the database', () => {
  it('writes the username only after Last.fm confirms the account exists', async () => {
    const { cmd, userService, lastfmRepository } = build();
    const response = await h(cmd).registerAsync(makeCtx({ strings: { username: '  SomeUser  ' } }));

    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith('SomeUser');
    expect(userService.setUserLastFm).toHaveBeenCalledWith('caller1', 'SomeUser');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('has been set to **SomeUser**');
  });

  it('writes NOTHING when Last.fm has no such user', async () => {
    // THE A1 TEST. `getUserInfo` returns null for a genuine Last.fm "no such
    // user" (code 6) and RAISES for everything else, so a null is a real
    // absence - and a database row pointing at it would make every later sync
    // report "0 scrobbles" for a person who never existed.
    const { cmd, userService, lastfmRepository } = build({ userInfo: null });
    const response = await h(cmd).registerAsync(makeCtx({ strings: { username: 'NobodyHere' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Could not find a Last.fm user named **NobodyHere**');
    expect(userService.setUserLastFm).not.toHaveBeenCalled();
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses an empty username before touching the network', async () => {
    const { cmd, userService, lastfmRepository } = build();
    for (const value of [undefined, '', '   ']) {
      const response = await h(cmd).registerAsync(makeCtx({ strings: { username: value } }));
      expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    }
    expect(lastfmRepository.getUserInfo).not.toHaveBeenCalled();
    expect(userService.setUserLastFm).not.toHaveBeenCalled();
  });

  it('refuses a username longer than Last.fm allows, without a lookup', async () => {
    const { cmd, userService, lastfmRepository } = build();
    const response = await h(cmd).registerAsync(
      makeCtx({ strings: { username: 'x'.repeat(256) } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('valid Last.fm username');
    expect(lastfmRepository.getUserInfo).not.toHaveBeenCalled();
    expect(userService.setUserLastFm).not.toHaveBeenCalled();
  });

  it('accepts a username of exactly the limit', async () => {
    const { cmd, lastfmRepository } = build();
    const name = 'x'.repeat(255);
    await h(cmd).registerAsync(makeCtx({ strings: { username: name } }));
    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith(name);
  });
});

describe('/fm: three separate not-found branches, none of which reads a scrobble', () => {
  it('refuses a caller who has never connected an account', async () => {
    const { cmd, lastfmRepository } = build({ caller: null });
    const response = await h(cmd).fmAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Use `/register` first');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses a named target who has not registered, and reads no scrobbles', async () => {
    const { cmd, lastfmRepository } = build({ byDiscordId: { other1: null } });
    const response = await h(cmd).fmAsync(makeCtx({ users: { user: { id: 'other1', username: 'other' } } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('hasn\'t connected their Last.fm account yet');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses an lfm name Last.fm has never heard of', async () => {
    const { cmd } = build({ userInfo: null, recentTracks: [] });
    const response = await h(cmd).fmAsync(makeCtx({ strings: { lfm: 'NobodyHere' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('NobodyHere');
  });

  it('routes a page option to the paged reader and its absence to the now-playing one', async () => {
    // The dispatcher picks the reader on the presence of `page`, so a reader that
    // answers the wrong question is entirely invisible on the card.
    const paged = build();
    await commandOf(paged.cmd, 'fm').executeAsync(makeCtx({ integers: { page: 2 } }));
    expect(paged.lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalled();
    expect(paged.lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();

    const nowPlaying = build({ userInfo: null, recentTracks: [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: true }] });
    await commandOf(nowPlaying.cmd, 'fm').executeAsync(makeCtx());
    expect(nowPlaying.lastfmRepository.getUserRecentTracks).toHaveBeenCalled();
    expect(nowPlaying.lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });
});

describe('/fm page=: the page number is clamped, not trusted', () => {
  it('refuses a caller who has never connected an account', async () => {
    const { cmd } = build({ caller: null });
    const response = await h(cmd).recentAsync(makeCtx({ integers: { page: 1 } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Use `/register` first');
  });

  it('refuses a named target who has not registered', async () => {
    const { cmd, lastfmRepository } = build({ byDiscordId: { other1: null } });
    const response = await h(cmd).recentAsync(
      makeCtx({ integers: { page: 1 }, users: { user: { id: 'other1', username: 'other' } } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('has not registered with the bot yet');
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('renders the honest empty rather than an error when there are no scrobbles', async () => {
    const { cmd } = build({ recentMetadata: { tracks: [], totalPages: 0, totalScrobbles: 0 } });
    const response = await h(cmd).recentAsync(makeCtx({ integers: { page: 1 } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No scrobbles found for');
  });

  it('clamps a negative page to 1 and an absurd one to 80', async () => {
    // A page of 0 or 99999 would either crash the offset arithmetic or ask
    // Last.fm for a window that does not exist; both must land on a real page.
    const low = build();
    await h(low.cmd).recentAsync(makeCtx({ integers: { page: -5 } }));
    expect(
      (low.lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mock.calls[0]![2],
    ).toBe(1);

    const high = build();
    await h(high.cmd).recentAsync(makeCtx({ integers: { page: 99999 } }));
    expect(
      (high.lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mock
        .calls[0]![2],
    ).toBe(80);
  });

  it('reads the target\'s scrobbles, not the caller\'s, when someone else is named', async () => {
    const { cmd, lastfmRepository } = build({
      byLastFmName: { SomeUser: { userId: 9, userNameLastFm: 'SomeUser', discordUserId: 'other1' } },
    });
    await h(cmd).recentAsync(makeCtx({ integers: { page: 1 }, strings: { username: 'SomeUser' } }));

    expect(
      (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    ).toBe('SomeUser');
  });

  it('still renders a page for an unregistered Last.fm name, saying whose it is', async () => {
    // The `username` option is a Last.fm name, not a bot account, so an
    // unregistered name is a legitimate target - it just cannot have a session
    // key. Rendering it is right; rendering it as the CALLER's page is not.
    const { cmd, lastfmRepository } = build({ byLastFmName: {} });
    await h(cmd).recentAsync(makeCtx({ integers: { page: 1 }, strings: { username: 'Stranger' } }));

    expect(
      (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    ).toBe('Stranger');
  });

  it('renders the real page footer when Last.fm answers', async () => {
    const { cmd } = build();
    const response = await h(cmd).recentAsync(makeCtx({ integers: { page: 2 } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('Recent tracks for');
    expect(text).toContain('4,321 scrobbles');
    expect(text).toContain('2/4');
  });
});

describe('/fmmode', () => {
  it('refuses before touching the settings table for an unregistered caller', async () => {
    const { cmd } = build({ caller: null });
    const response = await h(cmd).fmModeAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Use `/register` first');
  });

  it('renders the customise card for a registered caller', async () => {
    const { cmd } = build();
    const response = await h(cmd).fmModeAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });
});