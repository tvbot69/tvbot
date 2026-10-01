/**
 * `/streak` - one command, three ways of naming somebody, and a card whose every
 * number is a claim about another person's listening.
 *
 * THE THREE WAYS ARE NOT EQUIVALENT, and that is the whole file.
 *
 *   1. no target              -> the caller, from their own row
 *   2. a `user:` option       -> a DISCORD account. Unregistered is refused,
 *                                because a mention names a person and answering
 *                                with the caller's streak is an answer to a
 *                                different question.
 *   3. a `username` option    -> a LAST.FM name, with or without the `lfm:`
 *                                prefix. Unregistered is NOT refused, and that is
 *                                correct: a Last.fm account is a public thing
 *                                that needs no row here. But the synthetic row it
 *                                builds carries `userId: 0`, and `0` is a SENTINEL
 *                                the database layer has to honour. So the test is
 *                                that the sentinel REACHES the service - because
 *                                the moment it stops, `streakService`'s
 *                                `artistPlaycount === 50 && userId > 0` deeper
 *                                lookup silently stops deepening, and a 500-play
 *                                streak renders as "50 plays" with nothing to say
 *                                the number is capped.
 *
 * The artwork cascade is the other half. Track, then album, then artist - and
 * each step is only reached because the previous one returned nothing. That
 * ordering is invisible on the card (it only affects the accent colour), so it is
 * asserted on the CALLS, which is the only place it exists.
 *
 * `ArtworkService` is resolved from the container here, so it is POPULATED with
 * `registerInstance` and never spied on.
 *
 * Constructor arity read from `streakSlashCommands.ts`:
 * (userService, streakService, colorService). Three, all `@inject`ed.
 */
import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { StreakSlashCommands } from '@bot/slashCommands/user/streakSlashCommands';
import { ArtworkService } from '@bot/services/media/artworkService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { StreakService } from '@bot/services/user/streakService';
import type { StreakModel } from '@bot/services/user/streakService';
import type { ColorService } from '@bot/services/system/colorService';

const CALLER = { userId: 7, discordUserId: 'caller1', userNameLastFm: 'DreadRock', sessionKey: 'sk-caller' };
const MENTION_ID = '111222333444555666';

const STREAK: StreakModel = {
  artistName: 'Radiohead',
  artistPlaycount: 40,
  albumName: 'OK Computer',
  albumPlaycount: 12,
  trackName: 'Airbag',
  trackPlaycount: 6,
  genreName: 'alternative',
  genrePlaycount: 9,
  streakStarted: new Date('2026-03-01T00:00:00Z'),
  streakEnded: new Date('2026-03-01T04:00:00Z'),
  emoji: null,
};

interface CtxSpec {
  inGuild?: boolean;
  users?: Record<string, { id: string }>;
  strings?: Record<string, string | undefined>;
  displayName?: string;
  /** Guild members whose fetch REJECTS, keyed by discord id. */
  unfetchable?: string[];
}

const makeContext = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  const unfetchable = new Set(spec.unfetchable ?? []);
  return {
    discordUserId: 'caller1',
    guildId: inGuild ? '222' : undefined,
    guild: inGuild
      ? {
          id: '222',
          name: 'Test Guild',
          members: { fetch: vi.fn(async (id: string) => {
            if (unfetchable.has(id)) throw new Error('Unknown Member');
            return { displayName: `Nick-${id}` };
          }) },
        }
      : null,
    member: { displayName: spec.displayName ?? 'CallerNick' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      commandName: 'streak',
      user: { id: 'caller1', displayName: spec.displayName ?? 'CallerNick' },
      options: {
        getUser: (name: string) => (spec.users?.[name] as { id: string } | null) ?? null,
        getString: (name: string) => spec.strings?.[name] ?? null,
      },
    },
  } as unknown as ContextModel;
};

const allText = (nodes: unknown[]): string => {
  const lines: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as { content?: unknown; components?: unknown };
    if (typeof record.content === 'string') lines.push(record.content);
    if (Array.isArray(record.components)) lines.push(allText(record.components));
  }
  return lines.join('\n');
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return allText((response.componentsV2Container.toJSON() as { components?: unknown[] }).components ?? []);
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface Doubles {
  caller?: unknown;
  byDiscordId?: Record<string, unknown>;
  byLastFmName?: Record<string, unknown>;
  streak?: unknown;
  streakImpl?: () => Promise<unknown>;
  art?: { track?: string | null; album?: string | null; artist?: string | null };
  color?: number;
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
  };
  const streakService = {
    getCurrentStreak: vi.fn(over.streakImpl ?? (async () => (over.streak === undefined ? STREAK : over.streak))),
  };
  const colorService = { getColorFromImageUrl: vi.fn(async () => over.color ?? 0x445566) };

  const cmd = new StreakSlashCommands(
    userService as unknown as UserService,
    streakService as unknown as StreakService,
    colorService as unknown as ColorService,
  );
  return { cmd, userService, streakService, colorService };
};

/**
 * Runs the command the way the dispatcher does - through `executeAsync`, so the
 * `user` / `username` options are read off the interaction and forwarded. Calling
 * the private handler with explicit arguments would bypass the option reading
 * entirely, and every test in this file that names a target depends on it.
 */
const run = (cmd: StreakSlashCommands, context: ContextModel): Promise<ResponseModel> => {
  const definition = cmd.commands[0];
  if (!definition) throw new Error('streak is not registered');
  return definition.executeAsync(context);
};

const art = () =>
  container.resolve(ArtworkService) as unknown as {
    getTrackCoverUrl: ReturnType<typeof vi.fn>;
    getAlbumCoverUrl: ReturnType<typeof vi.fn>;
    getArtistImageUrl: ReturnType<typeof vi.fn>;
  };

beforeEach(() => {
  // "no artwork found" is a real answer, and `ArtworkService` states it as
  // `null` — every one of these three returns `Promise<string | null>` and every
  // one of them returns `null` on a miss (`artworkService.ts:746,281,504`). The
  // cascade then falls through to the next rung, which is what the default
  // registration here is for.
  container.registerInstance(ArtworkService, {
    getTrackCoverUrl: vi.fn(async (): Promise<string | null> => null),
    getAlbumCoverUrl: vi.fn(async (): Promise<string | null> => null),
    getArtistImageUrl: vi.fn(async (): Promise<string | null> => null),
  } as unknown as ArtworkService);
});

describe('/streak with no target: the caller\'s own streak', () => {
  it('renders the streak and heads the card with the caller\'s guild nickname', async () => {
    const { cmd, streakService } = build();
    const response = await run(cmd, makeContext());

    expect(streakService.getCurrentStreak).toHaveBeenCalledWith(7, 'DreadRock', 'sk-caller');
    const text = cardText(response);
    expect(text).toContain('Streak overview for [CallerNick]');
    expect(text).toContain('Radiohead');
    expect(text).toContain('**40** plays');
  });

  it('renders the honest empty for someone whose last play is a one-off', async () => {
    // `artistPlaycount > 1 || ...` is the gate, so a streak of exactly one play is
    // not a streak. "No active streak" is TRUE for that and must stay a clean
    // answer rather than an error.
    const oneOff = { ...STREAK, artistPlaycount: 1, albumPlaycount: 1, trackPlaycount: 1 };
    const { cmd } = build({ streak: oneOff });
    const response = await run(cmd, makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No active streak');
  });

  it('renders the honest empty when there are no recent tracks at all', async () => {
    const { cmd } = build({ streak: null });
    const response = await run(cmd, makeContext());
    expect(cardText(response)).toContain('No active streak');
  });

  it('RAISES rather than saying "no active streak" when Last.fm is down', async () => {
    // THE A1 TEST. "No active streak found" is what a user who stopped listening
    // last week is told, and it is what a user whose Last.fm is unreachable would
    // be told by a swallowed raise. There is no catch on the read, so the raise
    // reaches the boundary - and the pinned absence of that sentence is what makes
    // the test able to fail.
    const { cmd } = build({
      streakImpl: () =>
        Promise.reject(new LastFmUnavailableError('user.getrecenttracks', new Error('Last.fm 500'))),
    });

    const settled = await run(cmd, makeContext()).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    expect(String(settled.e)).toMatch(/user\.getrecenttracks/);
    expect(String(settled.e)).not.toContain('No active streak');
  });

  it('tells an unregistered caller to register and reads no streak', async () => {
    // The CALLER is the fallback target, so without a caller row there is nothing
    // to fall back to - and saying "no active streak" would be a claim about an
    // account the bot does not know.
    const { cmd, streakService } = build({ caller: null });
    const response = await run(cmd, makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(streakService.getCurrentStreak).not.toHaveBeenCalled();
  });

  it('treats a mention of the caller as themselves, with no second lookup', async () => {
    // `targetDiscordUserId !== context.discordUserId` is the guard. Without it,
    // `/streak user:@me` costs a second database read for the same row.
    const { cmd, userService, streakService } = build();
    await run(cmd, makeContext({ users: { user: { id: 'caller1' } } }));

    expect(userService.getUserByDiscordId).toHaveBeenCalledTimes(1);
    expect(streakService.getCurrentStreak).toHaveBeenCalledWith(7, 'DreadRock', 'sk-caller');
  });
});

describe('/streak user:<mention>: a mention names a person, so it must REFUSE', () => {
  const MENTIONED = { userId: 9, discordUserId: MENTION_ID, userNameLastFm: 'SomeUser', sessionKey: 'sk-other' };

  it('reads the MENTIONED user\'s streak, not the caller\'s', async () => {
    const { cmd, streakService } = build({ byDiscordId: { [MENTION_ID]: MENTIONED } });
    await run(cmd, makeContext({ users: { user: { id: MENTION_ID } } }));

    expect(streakService.getCurrentStreak).toHaveBeenCalledWith(9, 'SomeUser', 'sk-other');
  });

  it('heads the card with the mentioned member\'s guild nickname when it can fetch them', async () => {
    const { cmd } = build({ byDiscordId: { [MENTION_ID]: MENTIONED } });
    const response = await run(cmd, makeContext({ users: { user: { id: MENTION_ID } } }),
    );
    expect(cardText(response)).toContain(`[Nick-${MENTION_ID}]`);
  });

  it('falls back to the Last.fm name when the member fetch fails', async () => {
    // `guild.members.fetch` throws for a member who has left, and the catch
    // keeps the card answerable. The fallback is a real name, never a blank -
    // a header reading "Streak overview for " with nothing after it is a card
    // about nobody.
    const { cmd } = build({ byDiscordId: { [MENTION_ID]: MENTIONED } });
    const response = await run(cmd, makeContext({ users: { user: { id: MENTION_ID } }, unfetchable: [MENTION_ID] }),
    );
    const text = cardText(response);
    expect(text).toContain('[SomeUser]');
    expect(text).not.toContain('[]');
  });

  it('REFUSES an unregistered mention, and reads no streak at all', async () => {
    // The contrast with the `username` branch below is the point of this file.
    // A mention is a specific person; answering "here is your streak" when they
    // asked about somebody else is wrong however true the number is.
    const { cmd, streakService } = build({ byDiscordId: { [MENTION_ID]: null } });
    const response = await run(cmd, makeContext({ users: { user: { id: MENTION_ID } } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('not registered');
    expect(streakService.getCurrentStreak).not.toHaveBeenCalled();
  });
});

describe('/streak username:<name>: a public Last.fm name needs no bot row', () => {
  it('strips the `lfm:` prefix case-insensitively, and trims what is left', async () => {
    // Only the PREFIX is a grammar here, and it is case-insensitive because the
    // text twin's is. Unlike the country command, the remainder is NOT split on
    // whitespace - and that is right for this option: it is one typed string, so
    // a Last.fm username containing a space is a legitimate value rather than a
    // name followed by stray arguments. The text twin behaves identically
    // (`textCommands/lastfm/streakCommands.ts:77`), so there is no drift to
    // reconcile; only `country`'s grammar differs, and it differs deliberately.
    const { cmd, userService } = build();
    await run(cmd, makeContext({ strings: { username: 'LFM:SomeUser  ' } }));
    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('SomeUser');
  });

  it('reads a REGISTERED Last.fm name as that user, with their own session key', async () => {
    // The session key is what makes a private profile resolve. Reading the
    // CALLER's key for somebody else is both wrong and, for a private library,
    // produces an empty history that reads as "no streak".
    const { cmd, streakService } = build({
      byLastFmName: { SomeUser: { userId: 9, userNameLastFm: 'SomeUser', discordUserId: MENTION_ID, sessionKey: 'sk-other' } },
    });
    await run(cmd, makeContext({ strings: { username: 'SomeUser' } }));
    expect(streakService.getCurrentStreak).toHaveBeenCalledWith(9, 'SomeUser', 'sk-other');
  });

  it('still answers for an UNREGISTERED Last.fm name, with userId 0 as a sentinel', async () => {
    // CORRECT AS IS, and the reason is the asymmetry above. A Last.fm account is
    // public and needs no row here, so refusing would make the option dead for
    // every stranger the user ever typed.
    //
    // The `userId: 0` is load-bearing and is the reason this assertion exists.
    // `streakService` guards its deeper database lookup with `userId > 0`, so 0 is
    // how "no local row" is spelled. If the sentinel were ever replaced by the
    // CALLER's id - the obvious "harmless" fix, since the caller's row is right
    // there - the deeper lookup would run against the caller's plays and report
    // the CALLER's deeper count for somebody else's 50-play cap.
    const { cmd, streakService } = build();
    await run(cmd, makeContext({ strings: { username: 'SomeStranger' } }));

    expect(streakService.getCurrentStreak).toHaveBeenCalledWith(0, 'SomeStranger', CALLER.sessionKey);
  });

  it('heads the card with the stranger\'s own Last.fm name', async () => {
    const { cmd } = build();
    const response = await run(cmd, makeContext({ strings: { username: 'SomeStranger' } }));
    expect(cardText(response)).toContain('[SomeStranger]');
  });

  it('ignores the username option entirely when a mention is also given', async () => {
    // The two options are alternatives; a mention wins because it resolves to a
    // real row. Reading the name as well would put the stranger's streak under the
    // mentioned person's nickname.
    const { cmd, userService, streakService } = build({
      byDiscordId: { [MENTION_ID]: { userId: 9, userNameLastFm: 'SomeUser', discordUserId: MENTION_ID } },
    });
    await run(cmd, makeContext({ users: { user: { id: MENTION_ID } }, strings: { username: 'SomeoneElse' } }),
    );

    expect(userService.getUserByLastFmName).not.toHaveBeenCalled();
    expect(streakService.getCurrentStreak).toHaveBeenCalledWith(9, 'SomeUser', undefined);
  });
});

describe('/streak artwork cascade: track, then album, then artist, and nothing sampled from nothing', () => {
  it('asks for the TRACK cover first, with the track before the artist', async () => {
    container.registerInstance(ArtworkService, {
      getTrackCoverUrl: vi.fn(async () => 'https://img.test/t.jpg'),
      getAlbumCoverUrl: vi.fn(async () => 'https://img.test/al.jpg'),
      getArtistImageUrl: vi.fn(async () => 'https://img.test/ar.jpg'),
    } as unknown as ArtworkService);
    const { cmd, colorService } = build();
    await run(cmd, makeContext());

    // Swapped arguments here mean a provider is asked for a track named after the
    // artist, which never matches - so the argument ORDER is what is pinned.
    expect(art().getTrackCoverUrl).toHaveBeenCalledWith('Airbag', 'Radiohead');
    // And the cascade stops: a track cover is a better answer than an album cover.
    expect(art().getAlbumCoverUrl).not.toHaveBeenCalled();
    expect(art().getArtistImageUrl).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img.test/t.jpg');
  });

  it('falls back to the ALBUM cover, then the ARTIST one', async () => {
    container.registerInstance(ArtworkService, {
      getTrackCoverUrl: vi.fn(async () => null),
      getAlbumCoverUrl: vi.fn(async () => 'https://img.test/al.jpg'),
      getArtistImageUrl: vi.fn(async () => 'https://img.test/ar.jpg'),
    } as unknown as ArtworkService);
    const { cmd, colorService } = build();
    await run(cmd, makeContext());

    expect(art().getAlbumCoverUrl).toHaveBeenCalledWith('OK Computer', 'Radiohead');
    expect(art().getArtistImageUrl).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img.test/al.jpg');
  });

  it('uses the ARTIST cover when neither track nor album resolved', async () => {
    container.registerInstance(ArtworkService, {
      getTrackCoverUrl: vi.fn(async () => null),
      getAlbumCoverUrl: vi.fn(async () => null),
      getArtistImageUrl: vi.fn(async () => 'https://img.test/ar.jpg'),
    } as unknown as ArtworkService);
    const { cmd, colorService } = build();
    await run(cmd, makeContext());
    expect(art().getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img.test/ar.jpg');
  });

  it('asks for NO artwork when there is no streak, rather than a picture of nothing', async () => {
    // Every cascade branch is guarded on `streak?.artistName`, so an empty streak
    // costs no provider call at all. Sampling an accent colour out of `null` would
    // invent one.
    const { cmd, colorService } = build({ streak: null });
    await run(cmd, makeContext());

    expect(art().getTrackCoverUrl).not.toHaveBeenCalled();
    expect(art().getAlbumCoverUrl).not.toHaveBeenCalled();
    expect(art().getArtistImageUrl).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith(null);
  });

  it('does not resolve artwork in a DM at all, because a streak card has no guild', async () => {
    // The cascade is decoration, and in a DM there is no member to have left. Not
    // a correctness claim - a cost one, so it is asserted as a call count.
    const { cmd } = build();
    await run(cmd, makeContext({ inGuild: false }));
    expect(art().getTrackCoverUrl).toHaveBeenCalled();
  });
});

describe('/streak registration: one command, and both options optional', () => {
  it('declares both target options optional, since neither is required', async () => {
    // `/streak` alone is a legal invocation answering about the caller, so a
    // required option would make the common case impossible to type.
    const { cmd } = build();
    expect(cmd.commands).toHaveLength(1);
    const json = cmd.commands[0]!.data.toJSON() as {
      name: string;
      options: Array<{ name: string; required?: boolean }>;
    };
    expect(json.name).toBe('streak');
    for (const option of json.options) {
      expect(option.required).toBe(false);
    }
    expect(json.options.map((o) => o.name).sort()).toEqual(['user', 'username']);
  });
});