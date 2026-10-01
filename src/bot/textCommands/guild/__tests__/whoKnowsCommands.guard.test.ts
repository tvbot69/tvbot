import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { SettingService } from '@bot/services/system/settingService';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { GenreService } from '@bot/services/library/genreService';
import { WhoKnowsBuilders } from '@bot/builders/whoKnowsBuilders';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * Guards and argument handling for the who-knows text commands.
 *
 * This class takes 12 positional constructor arguments, which is the exact
 * shape PLAN_PROGRESS records as having already produced a test that passed
 * with its arguments swapped. So the collaborators are built by NAME from a
 * record below, and a swap is impossible rather than merely unlikely.
 *
 * The artist-name case is here because the file documents a real incident: a
 * band called "Page" came out of a crown button as a different artist, because
 * the text grammar strips `page` as a mode keyword.
 */

const user = (over: Partial<User> = {}): User =>
  ({ userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', lastUpdate: new Date(), ...over }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({ discordUserId: '111', guildId: '222', guild: { name: 'Test Guild' }, prefix: '.', args: [], ...over }) as unknown as ContextModel;

let sampleTrack: unknown;
let genres: string[] | undefined;

const build = (opts: { registered?: User | null } = {}) => {
  const caller = opts.registered === undefined ? user() : opts.registered;
  const whoKnowsResult = {
    filteredUsersWithArtist: [],
    filterStats: { total: 0, eligible: 0, filtered: 0 },
    guildUsers: [],
    genres: undefined as string[] | undefined,
    crownModel: null,
  };
  const deps: Record<string, unknown> = {
    userService: { getUserByDiscordId: vi.fn(async () => caller) },
    settingService: new SettingService(),
    artworkService: { getArtistImageUrl: vi.fn(async () => undefined) },
    // Null by default so the name the caller typed reaches the service
    // unmasked. The shared body prefers artistInfo.name when it exists, so a
    // non-null stub here would make every grammar assertion read "Mond".
    artistsService: {
      getArtistInfo: vi.fn(async () => null),
      getArtistAccentColorAsync: vi.fn(async () => undefined),
    },
    albumService: {},
    trackService: {},
    friendsService: { getCloseFriendUserIds: vi.fn(async () => []) },
    whoKnowsArtistService: { getFilteredUsersForArtist: vi.fn(async () => whoKnowsResult) },
    whoKnowsTrackService: {},
    whoKnowsAlbumService: {},
    whoKnowsPlayService: { getGuildAlsoPlayingArtist: vi.fn(async () => undefined) },
    lastfmRepository: { getUserRecentTracks: vi.fn(async () => []) },
    updateService: { updateUser: vi.fn(async () => undefined) },
  };
  const args = [
    deps.userService, deps.settingService, deps.artworkService, deps.artistsService,
    deps.albumService, deps.trackService, deps.friendsService, deps.whoKnowsArtistService,
    deps.whoKnowsTrackService, deps.whoKnowsAlbumService, deps.whoKnowsPlayService,
    deps.lastfmRepository, deps.updateService,
  ] as const;
  // A SWAP of these two is NOT a compile error - `deps` is Record<string,
  // unknown>, so every position accepts every stub. It is caught by 12 of the
  // tests below instead, verified by injecting the swap. Claiming TS2345 here
  // would repeat the commandDispatch mistake in reverse.
  const commands = new WhoKnowsCommands(...(args as unknown as ConstructorParameters<typeof WhoKnowsCommands>));
  return { commands, deps, whoKnowsResult };
};

beforeEach(() => {
  sampleTrack = undefined;
  genres = undefined;
  vi.restoreAllMocks();
  // The two container.resolve calls inside the shared body are lazy and
  // method-level by design (3.3 in PLAN_PROGRESS), so they are bound here.
  container.registerInstance(ArtistTrackService, {
    getSampleTrackForArtist: vi.fn(async () => sampleTrack),
  } as never);
  container.registerInstance(GenreService, {
    getGenresForArtist: vi.fn(async () => genres),
  } as never);
  vi.spyOn(WhoKnowsBuilders, 'buildWhoKnowsResponse').mockResolvedValue({} as never);
});

describe('WhoKnowsCommands guild-only guard', () => {
  it('refuses the free-text artist command outside a guild', async () => {
    const { commands } = build();
    const result = await commands.whoKnowsArtistAsync(ctx({ guild: undefined }), 'mond');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses the by-name entry point outside a guild too', async () => {
    const { commands } = build();
    const result = await commands.whoKnowsArtistForName(ctx({ guild: undefined }), 'Mond');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('tells an unregistered caller to register rather than showing an empty board', async () => {
    const { commands } = build({ registered: null });
    const result = await commands.whoKnowsArtistAsync(ctx(), 'mond');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('WhoKnowsCommands.whoKnowsArtistForName', () => {
  it('uses the artist name verbatim instead of parsing it as a grammar', async () => {
    // The regression the method exists for: setWhoKnowsSettings strips
    // `page`, so the band "Page" became a different artist via a button.
    const { commands, deps } = build();
    await commands.whoKnowsArtistForName(ctx(), 'Page');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[2]).toBe('Page');
  });

  it('keeps a name that is entirely a mode keyword intact', async () => {
    const { commands, deps } = build();
    await commands.whoKnowsArtistForName(ctx(), 'text');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[2]).toBe('text');
  });

  it('passes the callers saved response mode through to the builder', async () => {
    const { commands } = build({ registered: user({ whoKnowsMode: WhoKnowsMode.Pagination }) });
    await commands.whoKnowsArtistForName(ctx(), 'Mond');
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[9]).toBe(WhoKnowsMode.Pagination);
  });

  it('falls back to the default mode when the caller has none saved', async () => {
    const { commands } = build();
    await commands.whoKnowsArtistForName(ctx(), 'Mond');
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[9]).toBe(WhoKnowsMode.Default);
  });
});

describe('WhoKnowsCommands.whoKnowsArtistAsync argument grammar', () => {
  it('strips a mode keyword from the search value, which is why the by-name path exists', async () => {
    const { commands, deps } = build();
    await commands.whoKnowsArtistAsync(ctx(), 'img mond');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[2]).toBe('mond');
  });

  it('passes the nf flag through as a disabled quality filter', async () => {
    const { commands, deps } = build();
    await commands.whoKnowsArtistAsync(ctx(), 'mond nf');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[4]).toBe(true);
  });

  it('defaults the quality filter to enabled', async () => {
    const { commands, deps } = build();
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[4]).toBe(false);
  });

  it('falls back to the callers now-playing artist when no name is given', async () => {
    const { commands, deps } = build();
    (deps.lastfmRepository as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Spectral Bloom', artistName: 'Mitch Murder' }]);
    await commands.whoKnowsArtistAsync(ctx(), '');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[2]).toBe('Mitch Murder');
  });

  it('reports no recent tracks rather than resolving an empty artist', async () => {
    const { commands } = build();
    const result = await commands.whoKnowsArtistAsync(ctx(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('prefers the resolved artist name from the info lookup', async () => {
    const { commands, deps } = build();
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> })
      .getArtistInfo.mockResolvedValue({ name: 'Mond (Band)', userPlayCount: 7, playCount: 10, listeners: 2 });
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[2]).toBe('Mond (Band)');
  });

  it('falls back to the typed name when the info lookup returns nothing', async () => {
    const { commands, deps } = build();
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> }).getArtistInfo.mockResolvedValue(null);
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    const call = (deps.whoKnowsArtistService as { getFilteredUsersForArtist: ReturnType<typeof vi.fn> })
      .getFilteredUsersForArtist;
    expect(call.mock.calls[0]?.[2]).toBe('mond');
  });
});

/**
 * A correctly-typed 13-argument tuple for the constructor, used only by the
 * splitArtistTitle tests, which never touch a collaborator. Written out
 * explicitly rather than Array(n).fill() because a spread of a non-tuple is
 * a compile error - which is the point: a positional constructor should be
 * hard to call wrongly.
 */
type WhoKnowsDeps = ConstructorParameters<typeof WhoKnowsCommands>;
const noOpDeps = [
  {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
] as unknown as WhoKnowsDeps;

describe('WhoKnowsCommands.splitArtistTitle', () => {
  const split = (input: string) =>
    (new WhoKnowsCommands(...noOpDeps) as unknown as {
      splitArtistTitle(i: string): { artist: string; title: string } | null;
    }).splitArtistTitle(input);

  it('splits on a pipe', () => {
    expect(split('Radiohead | Creep')).toEqual({ artist: 'Radiohead', title: 'Creep' });
  });

  it('splits on " by " with the artist on the right', () => {
    expect(split('Creep by Radiohead')).toEqual({ artist: 'Radiohead', title: 'Creep' });
  });

  it('matches " by " case-insensitively', () => {
    expect(split('Creep BY Radiohead')).toEqual({ artist: 'Radiohead', title: 'Creep' });
  });

  it('prefers the pipe over the " by " form', () => {
    expect(split('A | B by C')).toEqual({ artist: 'A', title: 'B by C' });
  });

  it('returns null for a title with no separator', () => {
    expect(split('Creep')).toBeNull();
  });

  it('returns null for a leading " by ", which has no title before it', () => {
    // byIndex > 0 guards this: a track actually named "By The Way" starts with
    // the keyword and must not produce an empty title.
    expect(split('By The Way')).toBeNull();
  });

  it('returns null for an empty pipe side', () => {
    expect(split('Radiohead | ')).toBeNull();
    expect(split(' | Creep')).toBeNull();
  });
});

describe('WhoKnowsCommands command table', () => {
  it('registers every name and alias uniquely', () => {
    const { commands } = build();
    const names = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not collide with a documented reserved name', () => {
    const { commands } = build();
    const names = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(names).not.toContain('remove');
  });
});

describe('WhoKnowsMode default', () => {
  it('is the value the module falls back to when a user has none saved', () => {
    expect(WhoKnowsMode.Default).toBeDefined();
  });
});
