/**
 * `/crowns`, `/crown` and `/crownlb` - the three READ commands. `/crownseed`
 * and its admin gate are already covered by `crownSlashCommands.crownSeedAdmin.test.ts`
 * and are deliberately not repeated here.
 *
 * WHAT IS WORTH PINNING IN THIS FILE, in order of how badly a break would lie.
 *
 * 1. `/crown` with no artist argument and a Last.fm profile that has no recent
 *    tracks. The handler reads the caller's own last scrobble and, if there is
 *    none, answers "No recent tracks found ... Specify an artist". That message
 *    is TRUE in both the empty case and the unreadable case ONLY IF the read
 *    raises rather than returning empty - and `getUserRecentTracks` raises
 *    `LastFmUnavailableError` for an outage. So the pair is pinned: an outage
 *    must NOT render as a profile with no scrobbles, and a genuine empty must
 *    still render as one. This is the exact shape of the bug that
 *    `countrySlashCommands.lastFmUnavailable.test.ts` documents, one layer up
 *    and in a different command.
 *
 * 2. `/crowns user:@someone` where that someone has NOT registered. There used
 *    to be no `else` here either: `targetUser` stayed the caller while
 *    `targetDiscordId` had already been overwritten with the stranger's id. The
 *    card would then be the CALLER's crowns under the caller's own name, with
 *    the STRANGER's id in every pagination `customId`. Both halves are asserted
 *    here: the registered case must read the other user's crowns AND its
 *    buttons must carry that user's id, and the unregistered case must be
 *    visible as itself rather than as the caller's data with a stranger's
 *    buttons. `/crown artist:… user:@someone` had the same missing branch for
 *    the challenger, and is pinned in the same direction.
 *
 * 3. `/crownlb` works for an unregistered caller. The leaderboard is
 *    guild-wide, so requiring a Last.fm account to see it is a gate with no
 *    purpose; worse, the ranking footer reads "Your ranking: N/A" for them,
 *    which is the honest rendering of "we do not know where you are".
 *
 * 4. The accent colour is decoration in all three, read through the OPTIONAL
 *    constructor parameters. All seven are supplied positionally, so the
 *    `container.resolve` fallbacks are never taken and no shared client is
 *    touched.
 *
 * Constructor arity read from `crownSlashCommands.ts`:
 * (userService, crownService, lastfmRepo, artistsService, updateService,
 *  colorService?, artworkService?).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CrownSlashCommands } from '@bot/slashCommands/crown/crownSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { UpdateService } from '@bot/services/lastfm/updateService';
import type { ColorService } from '@bot/services/system/colorService';
import type { ArtworkService } from '@bot/services/media/artworkService';
import type { CrownService } from '@bot/services/crown/crownService';
import type { ArtistsService } from '@bot/services/library/artistsService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';

const CALLER = {
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
  sessionKey: 'sk-caller',
  lastUpdate: new Date(),
  totalPlayCount: 1000,
};
const OTHER = {
  userId: 9,
  discordUserId: 'other1',
  userNameLastFm: 'SomeUser',
  sessionKey: 'sk-other',
  lastUpdate: new Date(),
  totalPlayCount: 10,
};

const LFM_DOWN = () => new LastFmUnavailableError('user.getrecenttracks', new Error('Last.fm returned HTTP 500'));

const crown = (over: Partial<Record<string, unknown>> = {}) => ({
  crownId: 1,
  artistId: 2,
  artistName: 'Radiohead',
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
  startPlaycount: 30,
  currentPlaycount: 120,
  active: true,
  created: new Date('2026-01-01T00:00:00Z'),
  modified: new Date('2026-02-01T00:00:00Z'),
  ...over,
});

interface CtxSpec {
  inGuild?: boolean;
  strings?: Record<string, string | undefined>;
  integers?: Record<string, number | undefined>;
  users?: Record<string, { id: string }>;
  members?: Record<string, string>;
  iconUrl?: string | null;
  admin?: boolean;
}

const makeContext = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  const members = spec.members ?? {};
  const guild = inGuild
    ? {
        id: '222',
        name: 'Test Guild',
        iconURL: () => spec.iconUrl ?? null,
        members: { cache: { get: (id: string) => (members[id] ? { displayName: members[id] } : undefined) } },
      }
    : null;
  return {
    discordUserId: 'caller1',
    guildId: inGuild ? '222' : undefined,
    guild,
    prefix: '/',
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guildId: inGuild ? '222' : undefined,
      commandName: 'crowns',
      user: { id: 'caller1' },
      options: {
        getString: (name: string) => spec.strings?.[name] ?? null,
        getInteger: (name: string) => spec.integers?.[name] ?? null,
        getUser: (name: string) => spec.users?.[name] ?? null,
      },
    },
    userIsGuildAdmin: spec.admin ?? false,
  } as unknown as ContextModel;
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

/**
 * Every `customId` the card carries, at any depth.
 *
 * The pagination half of this file's bug is invisible in the rendered text: the
 * rows were the caller's own and true, and the wrongness lived entirely in
 * `crowns-page:*:<caller>:<target>:…`. A refusal that still built the card would
 * therefore pass any assertion on the text, so the ids are read off the
 * container's JSON and checked directly.
 */
const customIdsOf = (response: ResponseModel): string[] => {
  const found: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const record = node as { custom_id?: unknown; components?: unknown };
      if (typeof record.custom_id === 'string') found.push(record.custom_id);
      walk(record.components);
    }
  };
  walk((response.componentsV2Container?.toJSON() as { components?: unknown } | undefined)?.components);
  return found;
};

interface Doubles {
  caller?: unknown;
  byDiscordId?: Record<string, unknown>;
  crowns?: unknown[];
  currentCrown?: unknown;
  history?: unknown[];
  leaderboard?: { entries: Array<{ userId: number; displayName: string; crownCount: number; discordUserId: string }>; totalActiveCrowns: number };
  recent?: () => Promise<unknown[]>;
  artistInfo?: unknown;
  artUrl?: string | null;
  color?: number;
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id];
      return over.caller === undefined ? CALLER : over.caller;
    }),
  };
  const crownService = {
    getUserCrowns: vi.fn(async () => over.crowns ?? []),
    getCurrentCrown: vi.fn(async () => (over.currentCrown === undefined ? null : over.currentCrown)),
    getCrownHistory: vi.fn(async () => over.history ?? []),
    getGuildLeaderboard: vi.fn(async () =>
      over.leaderboard ?? { entries: [], totalActiveCrowns: 0 },
    ),
    seedCrowns: vi.fn(async () => 0),
  };
  const lastfmRepo = {
    getUserRecentTracks: vi.fn(over.recent ?? (async () => [])),
  };
  const artistsService = {
    getArtistInfo: vi.fn(async () => (over.artistInfo === undefined ? null : over.artistInfo)),
  };
  const updateService = { updateUser: vi.fn(async () => undefined) };
  const colorService = { getColorFromImageUrl: vi.fn(async () => over.color ?? 0x445566) };
  const artworkService = {
    getArtistImageUrl: vi.fn(async () => (over.artUrl === undefined ? 'https://img.test/a.jpg' : over.artUrl)),
  };

  const cmd = new CrownSlashCommands(
    userService as unknown as UserService,
    crownService as unknown as CrownService,
    lastfmRepo as unknown as ILastfmRepository,
    artistsService as unknown as ArtistsService,
    updateService as unknown as UpdateService,
    colorService as unknown as ColorService,
    artworkService as unknown as ArtworkService,
  );
  const privates = cmd as unknown as {
    crownsAsync(c: ContextModel): Promise<ResponseModel>;
    crownAsync(c: ContextModel): Promise<ResponseModel>;
    crownLbAsync(c: ContextModel): Promise<ResponseModel>;
  };
  return { cmd, privates, userService, crownService, lastfmRepo, artistsService, updateService, colorService, artworkService };
};

describe('/crowns: the target must be the person whose crowns are shown', () => {
  it('reads the caller\'s own crowns and titles the card with them', async () => {
    const { privates, crownService } = build({ crowns: [crown()] });
    const response = await privates.crownsAsync(makeContext({ members: { caller1: 'CallerNick' } }));

    expect(crownService.getUserCrowns).toHaveBeenCalledWith('222', 7, 'Playcount');
    expect(cardText(response)).toContain('Crowns for CallerNick');
    expect(cardText(response)).toContain('Radiohead');
  });

  it('reads the NAMED user\'s crowns when they are registered', async () => {
    // The counterpart to the refusal below. A `user:` option that resolved to the
    // caller would render the caller's crowns under the other person's name.
    const { privates, crownService } = build({
      byDiscordId: { other1: OTHER },
      crowns: [crown({ artistName: 'Portishead', discordUserId: 'other1', userId: 9 })],
    });
    const response = await privates.crownsAsync(
      makeContext({ users: { user: { id: 'other1' } }, members: { other1: 'OtherNick' } }),
    );

    expect(crownService.getUserCrowns).toHaveBeenCalledWith('222', 9, 'Playcount');
    expect(cardText(response)).toContain('Crowns for OtherNick');
    expect(cardText(response)).toContain('Portishead');
    // The positive half of the customId contract: the pagination really does
    // carry the TARGET's id, so the refusal above is a real difference and not
    // an artefact of the buttons always naming the caller.
    const pageIds = customIdsOf(response).filter((id) => id.startsWith('crowns-page:'));
    expect(pageIds.length).toBeGreaterThan(0);
    expect(pageIds.every((id) => id.includes(':other1:'))).toBe(true);
  });

  it('refuses an unregistered CHALLENGER on /crown instead of comparing against the caller', async () => {
    // The third instance of the same defect class, in the same file and the same
    // shape: `challengerOpt` with a `getUserByDiscordId` miss left
    // `challengerUser` as the caller, so `/crown artist:Radiohead user:@nobody`
    // printed the caller's own playcount as the challenger's and a gap nobody
    // asked about.
    const { privates, artistsService, crownService } = build({
      byDiscordId: { other1: null },
      artistInfo: { name: 'Radiohead', userPlayCount: 4321 },
    });
    const response = await privates.crownAsync(
      makeContext({ strings: { artist: 'Radiohead' }, users: { user: { id: 'other1' } } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('hasn\'t connected their Last.fm account yet');
    expect(artistsService.getArtistInfo).not.toHaveBeenCalled();
    expect(crownService.getCurrentCrown).not.toHaveBeenCalled();
  });

  it('REFUSES a named user who has not registered, rather than showing the caller\'s crowns', async () => {
    // THE FIX. `crownSlashCommands.ts:99-105` had no `else`, so `targetUser` stayed
    // the caller while `targetDiscordId` had already become the stranger's id. The
    // card was the caller's data under the caller's own name and a stranger's id
    // in the pagination buttons — the ROWS were true and only the buttons were
    // wrong, which is why the `customId`s are asserted here and not just the
    // rows. `intelligenceSlashCommands.resolveTarget` refuses the identical case
    // in the identical shape, so this uses the same builder and the same
    // `CommandResponse.NotFound`.
    const { privates, crownService } = build({ byDiscordId: { other1: null } });
    const response = await privates.crownsAsync(
      makeContext({ users: { user: { id: 'other1' } } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('hasn\'t connected their Last.fm account yet');
    // No query ran, so none of the caller's crowns are on screen in any form.
    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
    expect(cardText(response)).not.toContain('Radiohead');
    // And the half that was actually wrong: no pagination control carrying the
    // stranger's id is emitted at all. Asserting the absence of the id rather
    // than the absence of a word is what makes this the half that matters — a
    // fix that refused but still ran the builder would carry it.
    expect(customIdsOf(response).filter((id) => id.includes('other1'))).toEqual([]);
  });

  it('refuses an unregistered caller before reading any crown row', async () => {
    const { privates, crownService } = build({ caller: null });
    const response = await privates.crownsAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
  });

  it('refuses outside a server, ahead of the account check', async () => {
    // Guild-wide data. Outside a guild there is no guild, so the answer has to be
    // the guild refusal rather than an empty crown list.
    const { privates, crownService, userService } = build({ caller: null });
    const response = await privates.crownsAsync(makeContext({ inGuild: false }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('can only be used in a server');
    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
  });

  it('renders the honest empty for a user who genuinely holds no crowns', async () => {
    // The genuine empty, so the refusal above is not a blanket refusal. Note the
    // wording names the DISPLAY NAME and says "yet" - it must not read as a claim
    // that the server has none.
    const { privates } = build({ crowns: [] });
    const response = await privates.crownsAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('does not have any crowns in this server yet');
    expect(cardText(response)).toContain('0 total crowns');
  });

  it('clamps an out-of-range page instead of rendering an empty page under a number that does not exist', async () => {
    const { privates } = build({ crowns: [crown({ artistName: 'Radiohead' })] });
    const text = cardText(
      await privates.crownsAsync(makeContext({ integers: { page: 9999 } })),
    );
    expect(text).toContain('Page 1/1');
    expect(text).toContain('Radiohead');
  });

  it('samples the accent colour out of the top crown\'s own artwork', async () => {
    const { privates, artworkService, colorService } = build({ crowns: [crown()] });
    await privates.crownsAsync(makeContext());

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img.test/a.jpg');
  });

  it('asks for NO artwork when the user holds no crowns, rather than sampling nothing', async () => {
    // `topArtist ? await ... : null` - a null cover is an omitted block, not a
    // colour sampled out of an empty string.
    const { privates, artworkService, colorService } = build({ crowns: [] });
    await privates.crownsAsync(makeContext());

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith(null);
  });
});

describe('/crown: a Last.fm outage is not a listener who never scrobbled anything', () => {
  it('takes the artist from the caller\'s last scrobble when no artist is given', async () => {
    const { privates, lastfmRepo, artistsService, crownService } = build({
      recent: async () => [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
    });
    await privates.crownAsync(makeContext());

    expect(lastfmRepo.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1, 1, undefined, 'sk-caller');
    expect(artistsService.getArtistInfo).toHaveBeenCalledWith('Radiohead', 'DreadRock');
    expect(crownService.getCurrentCrown).toHaveBeenCalledWith('222', 'Radiohead');
  });

  it('reports the empty profile when there genuinely are no recent tracks', async () => {
    // The genuine empty. "No recent tracks found" is TRUE here, and it is the
    // same sentence the outage would produce if the raise were swallowed - which
    // is why the next test exists.
    const built = build({ recent: async () => [] });
    const response = await built.privates.crownAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No recent tracks found on your Last.fm profile');
    expect(cardText(response)).toContain('/crown artist:');
    expect(built.crownService.getCurrentCrown).not.toHaveBeenCalled();
  });

  it('RAISES rather than reporting an empty profile when Last.fm is down', async () => {
    // THE A1 TEST. The message the user would see for an outage and for a real
    // empty is byte-identical, and the advice is identical too - "Specify an
    // artist" - so a user whose Last.fm is unreachable would type the artist in
    // again and be told the same thing. The raise reaches the command boundary,
    // which names the source; the laundering version does not.
    const { privates, crownService } = build({ recent: () => Promise.reject(LFM_DOWN()) });

    await expect(privates.crownAsync(makeContext())).rejects.toBeInstanceOf(LastFmUnavailableError);
    // And it never got far enough to make a crown claim.
    expect(crownService.getCurrentCrown).not.toHaveBeenCalled();
  });

  it('never renders the "no recent tracks" card for an outage', async () => {
    // The user-visible half, asserted on what came back rather than on the thrown
    // type, so it fails for the right reason whichever way the catch is edited.
    const { privates } = build({ recent: () => Promise.reject(LFM_DOWN()) });
    const settled = await privates.crownAsync(makeContext()).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    expect(String(settled.e)).toMatch(/user\.getrecenttracks/);
    expect(String(settled.e)).not.toContain('No recent tracks found');
  });

  it('never asks Last.fm at all when the artist is given explicitly', async () => {
    // The read is a convenience, so an explicit argument must skip it: an extra
    // Last.fm round trip per command is a rate-limit cost for nothing.
    const { privates, lastfmRepo } = build();
    await privates.crownAsync(makeContext({ strings: { artist: 'Portishead' } }));

    expect(lastfmRepo.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('prefers the canonical artist name from the info lookup over the typed one', async () => {
    // "Boards of Canada" typed as "boards of canada" must render the name
    // Last.fm actually knows, or the whole card is built around an artist the
    // rest of the bot cannot resolve.
    const { privates, artistsService, crownService } = build({
      artistInfo: { name: 'Boards of Canada', userPlayCount: 55 },
    });
    const response = await privates.crownAsync(
      makeContext({ strings: { artist: 'boards of canada' } }),
    );

    expect(artistsService.getArtistInfo).toHaveBeenCalledWith('boards of canada', 'DreadRock');
    expect(crownService.getCurrentCrown).toHaveBeenCalledWith('222', 'Boards of Canada');
    expect(cardText(response)).toContain('Crown for Boards of Canada');
  });

  it('falls back to the typed name when the info lookup has nothing', async () => {
    const { privates, crownService } = build({ artistInfo: null });
    await privates.crownAsync(makeContext({ strings: { artist: 'Nobody Famous' } }));
    expect(crownService.getCurrentCrown).toHaveBeenCalledWith('222', 'Nobody Famous');
  });

  it('reports an unheld crown and the challenger\'s real playcount', async () => {
    // Two cards, two honest statements, asserted separately because the builder
    // REPLACES the "Nobody holds" sentence with the duel form once a playcount is
    // known. Conflating them would have asserted a sentence this card never shows.
    const withPlays = build({
      artistInfo: { name: 'Radiohead', userPlayCount: 4321 },
      currentCrown: null,
    });
    const duel = cardText(await withPlays.privates.crownAsync(makeContext({ strings: { artist: 'Radiohead' } })));
    expect(duel).toContain('No active crown holder');
    expect(duel).toContain('4,321 plays');
    expect(duel).toContain('Reach the required plays threshold');

    const noPlays = build({ artistInfo: { name: 'Radiohead', userPlayCount: 0 }, currentCrown: null });
    const plain = cardText(await noPlays.privates.crownAsync(makeContext({ strings: { artist: 'Radiohead' } })));
    expect(plain).toContain('Nobody holds the crown for');
    expect(plain).not.toContain('0 plays');
  });

  it('withholds the challenger clause when Last.fm has no playcount for them', async () => {
    // `artistInfo?.userPlayCount !== undefined` gates the whole clause. Dropping
    // the gate would print "— **0 plays**" for a user whose playcount could not be
    // read, which is a confident zero built out of a missing value.
    const { privates } = build({ artistInfo: { name: 'Radiohead' }, currentCrown: null });
    const text = cardText(await privates.crownAsync(makeContext({ strings: { artist: 'Radiohead' } })));

    expect(text).toContain('Nobody holds the crown for');
    expect(text).not.toContain('0 plays');
  });

  it('names the holder with their guild nickname and reports the gap to the challenger', async () => {
    const { privates } = build({
      artistInfo: { name: 'Radiohead', userPlayCount: 100 },
      currentCrown: crown({ discordUserId: 'other1', userNameLastFm: 'SomeUser', currentPlaycount: 120 }),
    });
    const response = await privates.crownAsync(
      makeContext({ strings: { artist: 'Radiohead' }, members: { other1: 'OtherNick' } }),
    );

    expect(cardText(response)).toContain('OtherNick');
    expect(cardText(response)).toContain('120 plays');
    expect(cardText(response)).toContain('20 plays** behind');
  });

  it('compares against a named challenger rather than silently against the caller', async () => {
    // `/crown artist:X user:@someone` is a comparison; answering with the caller's
    // own playcount would print a gap that is not the one the user asked for.
    const { privates, artistsService } = build({
      byDiscordId: { other1: OTHER },
      artistInfo: { name: 'Radiohead', userPlayCount: 5 },
      currentCrown: crown(),
    });
    await privates.crownAsync(
      makeContext({ strings: { artist: 'Radiohead' }, users: { user: { id: 'other1' } } }),
    );

    expect(artistsService.getArtistInfo).toHaveBeenCalledWith('Radiohead', 'SomeUser');
  });

  it('reads the crown AND its history for the SAME artist', async () => {
    // They go out in one `Promise.all`. A handler that resolved one against the
    // typed name and the other against the canonical one would render a card that
    // is about two different artists.
    const { privates, crownService } = build({ artistInfo: { name: 'Radiohead' } });
    await privates.crownAsync(makeContext({ strings: { artist: '  radiohead  ' } }));

    expect(crownService.getCurrentCrown).toHaveBeenCalledWith('222', 'Radiohead');
    expect(crownService.getCrownHistory).toHaveBeenCalledWith('222', 'Radiohead');
  });

  it('refuses outside a server and does not read Last.fm to find out why', async () => {
    const { privates, lastfmRepo } = build();
    const response = await privates.crownAsync(makeContext({ inGuild: false }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(lastfmRepo.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('tells an unregistered caller to register before reading anything', async () => {
    const { privates, lastfmRepo, crownService } = build({ caller: null });
    const response = await privates.crownAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(lastfmRepo.getUserRecentTracks).not.toHaveBeenCalled();
    expect(crownService.getCurrentCrown).not.toHaveBeenCalled();
  });
});

describe('/crownlb: guild-wide data, so no account is required', () => {
  it('renders the leaderboard for a caller who has never registered', async () => {
    // `caller` is resolved and then only used for `caller?.userId`. There is no
    // guard here, and there should not be: the data is the server's, and gating it
    // on a Last.fm account would hide it from exactly the members who have not
    // connected yet. The ranking footer is the honest rendering - "N/A", not 0.
    const { privates, crownService } = build({
      caller: null,
      leaderboard: {
        entries: [{ userId: 3, displayName: 'Holder', crownCount: 5, discordUserId: 'holder1' }],
        totalActiveCrowns: 5,
      },
    });
    const response = await privates.crownLbAsync(makeContext());

    expect(crownService.getGuildLeaderboard).toHaveBeenCalledWith('222');
    expect(cardText(response)).toContain('Holder');
    expect(cardText(response)).toContain('Your ranking: N/A');
  });

  it('replaces a stale stored display name with the current guild nickname', async () => {
    // The repository row carries whatever the name was when the crown was taken;
    // a rename after that would otherwise leave the leaderboard showing the old
    // name, which is a wrong answer about a person in the room.
    const { privates } = build({
      leaderboard: {
        entries: [{ userId: 3, displayName: 'OldName', crownCount: 2, discordUserId: 'holder1' }],
        totalActiveCrowns: 2,
      },
    });
    const response = await privates.crownLbAsync(makeContext({ members: { holder1: 'NewName' } }));

    expect(cardText(response)).toContain('NewName');
    expect(cardText(response)).not.toContain('OldName');
  });

  it('keeps the stored name for a member who has since left the server', async () => {
    // The other half of the branch: no cached member means no replacement, and a
    // blank name would be a worse answer than a stale one.
    const { privates } = build({
      leaderboard: {
        entries: [{ userId: 3, displayName: 'FormerMember', crownCount: 2, discordUserId: 'gone1' }],
        totalActiveCrowns: 2,
      },
    });
    const response = await privates.crownLbAsync(makeContext());
    expect(cardText(response)).toContain('FormerMember');
  });

  it('reports the caller\'s own rank when they are on the board', async () => {
    const { privates } = build({
      leaderboard: {
        entries: [
          { userId: 3, displayName: 'First', crownCount: 9, discordUserId: 'a1' },
          { userId: 7, displayName: 'Second', crownCount: 4, discordUserId: 'caller1' },
        ],
        totalActiveCrowns: 13,
      },
    });
    const response = await privates.crownLbAsync(makeContext());
    expect(cardText(response)).toContain('Your ranking: #2');
  });

  it('says N/A for a registered caller who is not on the board', async () => {
    // Not `#1` and not a zero rank. "You have no crowns" and "your rank could not
    // be found in this list" are different claims, and only the second is true.
    const { privates } = build({
      leaderboard: {
        entries: [{ userId: 3, displayName: 'First', crownCount: 9, discordUserId: 'a1' }],
        totalActiveCrowns: 9,
      },
    });
    const response = await privates.crownLbAsync(makeContext());
    expect(cardText(response)).toContain('Your ranking: N/A');
  });

  it('renders the honest empty for a server with no crowns at all', async () => {
    const { privates } = build({ leaderboard: { entries: [], totalActiveCrowns: 0 } });
    const response = await privates.crownLbAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No active crowns in this server yet');
  });

  it('clamps an out-of-range page rather than rendering an empty page', async () => {
    const { privates } = build({
      leaderboard: {
        entries: [{ userId: 3, displayName: 'Holder', crownCount: 1, discordUserId: 'a1' }],
        totalActiveCrowns: 1,
      },
    });
    const text = cardText(await privates.crownLbAsync(makeContext({ integers: { page: 42 } })));
    expect(text).toContain('Page 1/1');
    expect(text).toContain('Holder');
  });

  it('takes the accent from the server icon, and asks for nothing when there is no icon', async () => {
    const withIcon = build();
    await withIcon.privates.crownLbAsync(makeContext({ iconUrl: 'https://cdn.test/icon.png' }));
    expect(withIcon.colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn.test/icon.png');

    // A guild with no icon is common; sampling a colour out of null is not an
    // answer, so the brand colour must stand.
    const withoutIcon = build();
    await withoutIcon.privates.crownLbAsync(makeContext({ iconUrl: null }));
    expect(withoutIcon.colorService.getColorFromImageUrl).toHaveBeenCalledWith(null);
  });

  it('refuses outside a server without reading the leaderboard', async () => {
    const { privates, crownService } = build();
    const response = await privates.crownLbAsync(makeContext({ inGuild: false }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('can only be used in a server');
    expect(crownService.getGuildLeaderboard).not.toHaveBeenCalled();
  });
});

describe('all three commands: a stale account refreshes without blocking the answer', () => {
  it('kicks off a refresh for a caller whose totals are old, and still answers', async () => {
    // `void this.updateService.updateUser(...)` - fire and forget. The card must
    // not wait on it, and a card whose totals came from the refresh would be a
    // card the user cannot get on the next call.
    const stale = { ...CALLER, lastUpdate: new Date('2020-01-01T00:00:00Z') };
    const { privates, updateService } = build({ caller: stale, crowns: [crown()] });
    const response = await privates.crownsAsync(makeContext());

    expect(updateService.updateUser).toHaveBeenCalledWith(7, { accurateTotal: true });
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Radiohead');
  });

  it('does not refresh an account updated minutes ago', async () => {
    // The other half, and what stops the refresh from becoming a write on every
    // invocation.
    const fresh = { ...CALLER, lastUpdate: new Date() };
    const { privates, updateService } = build({ caller: fresh, crowns: [crown()] });
    await privates.crownsAsync(makeContext());
    expect(updateService.updateUser).not.toHaveBeenCalled();
  });

  it('refreshes the NAMED user too, not only the caller', async () => {
    // The branch inside the `if (other)` block. A named user's card built from a
    // never-refreshed total is a number the caller can see and cannot fix.
    const staleOther = { ...OTHER, lastUpdate: new Date('2020-01-01T00:00:00Z') };
    const { privates, updateService } = build({
      byDiscordId: { other1: staleOther },
      crowns: [],
    });
    await privates.crownsAsync(makeContext({ users: { user: { id: 'other1' } } }));
    expect(updateService.updateUser).toHaveBeenCalledWith(9, { accurateTotal: true });
  });
});
