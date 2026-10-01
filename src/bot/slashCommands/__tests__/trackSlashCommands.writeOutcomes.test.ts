/**
 * `/track`, `/trackdetails`, `/love`, `/unlove`, `/loved`, `/scrobble`.
 *
 * THE A1 PROPERTY IN THIS FILE IS `loveTrack` RETURNING FALSE.
 *
 * `LastFmRepository.loveTrack` catches everything and returns a boolean
 * (`lastFmRepository.ts:764-780`) - a rejected `track.love` because the session
 * key expired, because the track is not scrobblable, or because Last.fm was
 * down all become `false`. So the ONLY thing standing between a transport
 * failure and a confident "Loved **Airbag** by **Radiohead** on Last.fm" is the
 * `if (!success)` arm. If that arm were ever widened into a `catch`, every
 * Last.fm outage would be published as a successful love. Asserted on the
 * rendered card, not just the enum, because the enum alone would still pass a
 * builder that printed the success sentence anyway.
 *
 * The session-key gate is the same property one step earlier: `loveTrack` needs
 * `sk`, so a user who never ran `/login` cannot have a love applied at all, and
 * the handler must say so before it reaches the repository.
 *
 * There is also an argument-shape property in `/track`, pinned at the bottom:
 * the two separate options are joined into the one string the command documents,
 * and they must be joined in the order `TrackService.searchTrack` parses that
 * string — `artist | track`. The one-string form is parsed the other way round
 * in `/love` and `/trackdetails`, which is correct for their own option, and
 * that disagreement is what made the inverted join look plausible.
 *
 * Constructor arity, read from `trackSlashCommands.ts`: userService,
 * trackService, trackDetailsService, lastfmRepository, updateService,
 * colorService?.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { TrackSlashCommands } from '../trackSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/userService';
import type { TrackService } from '@bot/services/trackService';
import type { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { UpdateService } from '@bot/services/lastfm/updateService';
import type { ColorService } from '@bot/services/system/colorService';

const CALLER = {
  userId: 7,
  userNameLastFm: 'DreadRock',
  discordUserId: 'caller1',
  sessionKey: 'sk-abc',
  lastUpdate: new Date(),
  totalPlayCount: 4321,
};

const TRACK_RESULT = {
  trackName: 'Airbag',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  trackUrl: 'https://www.last.fm/music/Radiohead/_/Airbag',
  artistUrl: 'https://www.last.fm/music/Radiohead',
  albumUrl: 'https://www.last.fm/music/Radiohead/OK%20Computer',
  coverUrl: 'https://img.test/airbag.jpg',
  durationSeconds: 284,
  userPlaycount: 12,
  globalPlaycount: 900,
  globalListeners: 4,
  isLoved: true,
};

/**
 * Every text component on a Components V2 card, at any depth.
 *
 * RECURSIVE on purpose. The builder puts the header inside a `Section`, so its
 * `TextDisplay` is at `components[0].components[0]`, not at the top level. A
 * non-recursive walk reads the stat lines and silently misses the track title,
 * which is exactly the assertion this file is making.
 */
const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    const walk = (nodes: unknown[]): string[] =>
      nodes.flatMap((node) => {
        const n = node as { content?: unknown; components?: unknown[] };
        const own = typeof n.content === 'string' ? [n.content] : [];
        return [...own, ...(Array.isArray(n.components) ? walk(n.components) : [])];
      });
    return walk(
      (response.componentsV2Container.toJSON() as { components: unknown[] }).components,
    ).join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

/**
 * Every link a card offers, button or text, at any depth.
 *
 * A store link is a `Button` carrying a `url`, not a `content` string, so it is
 * invisible to `cardText` — and "the card offers the Spotify track" is a
 * different claim from "the card names the track".
 */
const cardLinks = (response: ResponseModel): string => {
  if (!response.componentsV2Container) return '';
  const walk = (nodes: unknown[]): string[] =>
    nodes.flatMap((node) => {
      const n = node as { url?: unknown; components?: unknown[] };
      const own = typeof n.url === 'string' ? [n.url] : [];
      return [...own, ...(Array.isArray(n.components) ? walk(n.components) : [])];
    });
  return walk(
    (response.componentsV2Container.toJSON() as { components: unknown[] }).components,
  ).join('\n');
};

interface CtxSpec {
  strings?: Record<string, string | undefined>;
  users?: Record<string, { id: string; username: string }>;
  memberDisplayName?: string;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => ({
  discordUserId: 'caller1',
  guildId: '222',
  guild: { id: '222', name: 'Loud Room', members: { cache: { get: () => undefined } } },
  member: { displayName: spec.memberDisplayName ?? 'Caller' },
  accentColor: 0x445566,
  interaction: {
    channelId: 'text1',
    id: 'i1',
    guild: { id: '222', name: 'Loud Room', members: { cache: { get: () => undefined } } },
    user: { id: 'caller1', username: 'caller' },
    options: {
      getString: (name: string) => spec.strings?.[name] ?? null,
      getUser: (name: string) => spec.users?.[name] ?? null,
    },
  },
  userIsGuildAdmin: false,
}) as unknown as ContextModel;

/** What `TrackDetailsService` returns when no provider could resolve anything. */
const NO_DETAILS = {
  trackName: 'Airbag',
  artistName: 'Radiohead',
  durationMs: 0,
  durationFormatted: '0:00',
  bpm: null,
  key: null,
  previewUrl: null,
  storeUrl: null,
  artworkUrl: null,
  spotifyUrl: null,
  resolved: null,
};

const RESOLVED_DETAILS = {
  ...NO_DETAILS,
  durationMs: 284000,
  durationFormatted: '4:44',
  bpm: 128.4,
  key: 'C# minor',
  previewUrl: 'https://preview.test/airbag.mp3',
  storeUrl: 'https://open.spotify.com/track/abc',
  spotifyUrl: 'https://open.spotify.com/track/abc',
  artworkUrl: 'https://img.test/airbag.jpg',
  resolved: { source: 'deezer', previewUrl: 'https://preview.test/airbag.mp3' },
};

interface Doubles {
  user?: unknown;
  searchTrack?: () => Promise<unknown>;
  getDetails?: () => Promise<unknown>;
  detailsImpl?: () => Promise<unknown>;
  loveOk?: boolean;
  unloveOk?: boolean;
  scrobbleOk?: boolean;
  recent?: unknown[];
  searchResults?: unknown[];
  loved?: { tracks: unknown[]; total: number };
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.user === undefined ? CALLER : over.user)),
  } as unknown as UserService;
  const trackService = {
    searchTrack: vi.fn(over.searchTrack ?? (async () => TRACK_RESULT)),
  } as unknown as TrackService;
  const detailsFor = (): Promise<unknown> =>
    over.detailsImpl ? over.detailsImpl() : Promise.resolve(NO_DETAILS);
  const trackDetailsService = {
    getDetails: vi.fn(over.getDetails ?? detailsFor),
  } as unknown as TrackDetailsService;
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async () => (over.recent ?? [])),
    // The search double answers a HIT by default: real Last.fm knows "Airbag",
    // and an empty list for a well-known track is a claim about the provider
    // that only became visible when `/trackdetails` started answering an empty
    // search with a not-found instead of building an "Unknown Artist" card. Tests
    // that want the empty answer pass `searchResults: []`.
    searchTracks: vi.fn(async () => (over.searchResults ?? [{ artistName: 'Radiohead', name: 'Airbag' }])),
    loveTrack: vi.fn(async () => over.loveOk ?? true),
    unloveTrack: vi.fn(async () => over.unloveOk ?? true),
    scrobbleTrack: vi.fn(async () => over.scrobbleOk ?? true),
    getLovedTracks: vi.fn(async () => over.loved ?? { tracks: [], total: 0 }),
  } as unknown as ILastfmRepository;
  const updateService = { updateUser: vi.fn(async () => undefined) } as unknown as UpdateService;
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => 0x112233),
  } as unknown as ColorService;

  const cmd = new TrackSlashCommands(
    userService,
    trackService,
    trackDetailsService,
    lastfmRepository,
    updateService,
    colorService,
  );
  return {
    cmd,
    userService,
    trackService,
    trackDetailsService,
    lastfmRepository,
    updateService,
    colorService,
  };
};

type Handlers = {
  trackAsync(c: ContextModel): Promise<ResponseModel>;
  trackDetailsAsync(c: ContextModel): Promise<ResponseModel>;
  loveAsync(c: ContextModel): Promise<ResponseModel>;
  unloveAsync(c: ContextModel): Promise<ResponseModel>;
  lovedAsync(c: ContextModel): Promise<ResponseModel>;
  scrobbleAsync(c: ContextModel): Promise<ResponseModel>;
};
const h = (cmd: TrackSlashCommands) => cmd as unknown as Handlers;

describe('/track: a target that is not registered is never charted', () => {
  it('tells an unregistered caller to register, not to retry', async () => {
    const { cmd, trackService } = build({ user: null });
    const response = await h(cmd).trackAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('You have not connected your Last.fm account');
    expect(trackService.searchTrack).not.toHaveBeenCalled();
  });

  it('uses a DIFFERENT sentence for a named target that has not registered', async () => {
    // The two NotFound branches are the only thing that tells "you" apart from
    // "the person you asked about", and getting them the wrong way round sends
    // the user off to fix the wrong account.
    const { cmd, trackService } = build({ user: null });
    const response = await h(cmd).trackAsync(
      makeCtx({ users: { user: { id: 'other1', username: 'other' } } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('That user has not registered with the bot yet.');
    expect(trackService.searchTrack).not.toHaveBeenCalled();
  });

  it('reports a genuine miss with the hint that makes it fixable', async () => {
    const { cmd } = build({ searchTrack: async () => null });
    const response = await h(cmd).trackAsync(makeCtx({ strings: { track: 'zzzz' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No track could be found');
  });
});

describe('/track: the voice preview is decoration, the numbers are not', () => {
  it('still renders the card when the metadata lookup REJECTS', async () => {
    // `getDetails(...).catch(() => null)`. Every number on the card came from
    // `searchTrack`, which is outside that catch, so a preview-resolver outage
    // must cost the preview button and nothing else. Losing the whole card would
    // be the worse regression.
    const { cmd } = build({
      getDetails: async () => {
        throw new Error('preview resolver exploded');
      },
    });
    const response = await h(cmd).trackAsync(makeCtx({ strings: { track: 'Airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('Airbag');
    expect(text).toContain('**12** plays by **Caller**');
  });

  it('still renders the card when the lookup simply resolves nothing', async () => {
    const { cmd } = build({ detailsImpl: async () => NO_DETAILS });
    const response = await h(cmd).trackAsync(makeCtx({ strings: { track: 'Airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('**12** plays by **Caller**');
  });

  it('shows the real duration and offers the store link when the lookup resolves', async () => {
    const { cmd } = build({ detailsImpl: async () => RESOLVED_DETAILS });
    const response = await h(cmd).trackAsync(makeCtx({ strings: { track: 'Airbag' } }));

    expect(cardText(response)).toContain('4:44');
    // A store link is a Button `url`, not a text `content`, so it is read from
    // the card's links rather than its text.
    expect(cardLinks(response)).toContain('https://open.spotify.com/track/abc');
  });

  it('composes the two options in the order the parser splits them, so the search runs for the right song', async () => {
    // The command documents `Track name (or "Artist | Track")`, and
    // `TrackService.searchTrack` (trackService.ts:107-110) splits on ' | ' as
    // `artist | track`. Supplying BOTH options built `"${track} | ${artist}"`
    // (trackSlashCommands.ts:104), so `/track track:"Airbag" artist:"Radiohead"`
    // searched for a track called "Radiohead" by an artist called "Airbag".
    //
    // Asserted as composer-versus-splitter rather than as a string, so the test
    // is about the agreement and not about one literal: the same split the
    // service performs is applied here to whatever the command handed it.
    const { cmd, trackService } = build();
    await h(cmd).trackAsync(makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }));

    const composed = vi.mocked(trackService.searchTrack).mock.calls[0]![0] as string;
    const [searchedArtist, searchedTrack] = composed.split(' | ').map((part) => part.trim());
    expect(searchedArtist).toBe('Radiohead');
    expect(searchedTrack).toBe('Airbag');
  });

  it('still hands a single option through untouched, so the "by" grammar keeps working', async () => {
    // The control. Only the two-option join is this command's business: with one
    // option the raw string must reach the service untouched, or `/track
    // track:"Airbag by Radiohead"` would stop resolving.
    const { cmd, trackService } = build();
    await h(cmd).trackAsync(makeCtx({ strings: { track: 'Airbag by Radiohead' } }));

    expect(trackService.searchTrack).toHaveBeenCalledWith('Airbag by Radiohead', CALLER, '222');
  });
});

describe('/trackdetails', () => {
  it('refuses rather than guessing when there is no query and no recent track', async () => {
    const { cmd, trackDetailsService } = build({ recent: [] });
    const response = await h(cmd).trackDetailsAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No recent tracks found');
    expect(trackDetailsService.getDetails).not.toHaveBeenCalled();
  });

  it('defaults to the caller\'s most recent track', async () => {
    const { cmd, trackDetailsService } = build({
      recent: [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
    });
    await h(cmd).trackDetailsAsync(makeCtx());

    expect(trackDetailsService.getDetails).toHaveBeenCalledWith(
      'Radiohead',
      'Airbag',
      expect.stringMatching(/^td_caller1_\d+$/),
    );
  });

  it('splits "Artist | Track" in the order the command documents', async () => {
    const { cmd, trackDetailsService } = build();
    await h(cmd).trackDetailsAsync(makeCtx({ strings: { track: 'Radiohead | Airbag' } }));

    expect(trackDetailsService.getDetails).toHaveBeenCalledWith(
      'Radiohead',
      'Airbag',
      expect.stringMatching(/^td_caller1_\d+$/),
    );
  });

  it('splits "Track by Artist" the other way round, as the grammar requires', async () => {
    const { cmd, trackDetailsService } = build();
    await h(cmd).trackDetailsAsync(makeCtx({ strings: { track: 'Airbag by Radiohead' } }));

    expect(trackDetailsService.getDetails).toHaveBeenCalledWith(
      'Radiohead',
      'Airbag',
      expect.stringMatching(/^td_caller1_\d+$/),
    );
  });

  it('says not-found when a bare search matches nothing at all', async () => {
    // It used to build a metadata card labelled "Unknown Artist" with the user's
    // raw text as the track name — a confident card for a question Last.fm could
    // not answer. `/love`, `/unlove` and the text `.trackdetails` answer the same
    // empty search with a not-found, and so does this.
    const { cmd, trackDetailsService } = build({ searchResults: [] });
    const response = await h(cmd).trackDetailsAsync(makeCtx({ strings: { track: 'qzx nonexistent' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('qzx nonexistent');
    expect(trackDetailsService.getDetails).not.toHaveBeenCalled();
  });

  it('renders the no-metadata card when the details read raises, exactly as /track does', async () => {
    // The twins disagreed: `/track` swallowed the enrichment failure and rendered
    // the card without the preview, `/trackdetails` propagated it and the user got
    // a Discord error instead of a card. Same read, same failure, two answers.
    // `getDetails` is decoration only — no number on either card comes from it —
    // so an outage of the preview resolver costs the metadata block, not the
    // command.
    const { cmd } = build({ getDetails: async () => { throw new Error('preview resolver exploded'); } });
    const response = await h(cmd).trackDetailsAsync(makeCtx({ strings: { track: 'Airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain("don't have any metadata for");
  });

  it('renders the no-metadata card for a track no provider knows', async () => {
    const { cmd } = build({ detailsImpl: async () => NO_DETAILS });
    const response = await h(cmd).trackDetailsAsync(makeCtx({ strings: { track: 'Airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain("don't have any metadata for");
  });

  it('renders the real detail card when a provider resolved', async () => {
    const { cmd } = build({ detailsImpl: async () => RESOLVED_DETAILS });
    const response = await h(cmd).trackDetailsAsync(makeCtx({ strings: { track: 'Airbag' } }));

    const text = cardText(response);
    expect(text).toContain('128.4');
    expect(text).toContain('C# minor');
  });
});

describe('/love and /unlove: a failed write must never read as a successful one', () => {
  it('refuses without a session key and never calls the repository', async () => {
    const { cmd, lastfmRepository } = build({ user: { ...CALLER, sessionKey: undefined } });
    const response = await h(cmd).loveAsync(makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }));

    expect(response.commandResponse).toBe(CommandResponse.NoPermission);
    expect(cardText(response)).toContain('Session key required');
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller before the session-key check', async () => {
    const { cmd, lastfmRepository } = build({ user: null });
    const response = await h(cmd).unloveAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.unloveTrack).not.toHaveBeenCalled();
  });

  it('renders an ERROR, not "Loved", when Last.fm refuses the love', async () => {
    // THE A1 TEST. `loveTrack` swallows every throw and returns false, so an
    // outage and a genuine refusal are the same boolean. Rendering the success
    // card here would publish a love that never happened.
    const { cmd } = build({ loveOk: false });
    const response = await h(cmd).loveAsync(
      makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.Error);
    const text = cardText(response);
    expect(text).toContain('Failed to love');
    expect(text).not.toContain('Loved **');
  });

  it('renders the success card only when the repository says it worked', async () => {
    const { cmd, lastfmRepository } = build({ loveOk: true });
    const response = await h(cmd).loveAsync(
      makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }),
    );

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'sk-abc');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Loved **Airbag** by **Radiohead**');
  });

  it('renders an ERROR, not "Unloved", when Last.fm refuses the unlove', async () => {
    const { cmd } = build({ unloveOk: false });
    const response = await h(cmd).unloveAsync(
      makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.Error);
    const text = cardText(response);
    expect(text).toContain('Failed to unlove');
    expect(text).not.toContain('Unloved **');
  });

  it('refuses rather than loving a guess when a bare name matches nothing', async () => {
    const { cmd, lastfmRepository } = build({ searchResults: [] });
    const response = await h(cmd).loveAsync(makeCtx({ strings: { track: 'qzx nonexistent' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Could not find track matching');
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('loves the now-playing track when neither option is given', async () => {
    const { cmd, lastfmRepository } = build({
      recent: [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
    });
    const response = await h(cmd).loveAsync(makeCtx());

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Airbag', 'sk-abc');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('refuses when the caller has never scrobbled anything', async () => {
    const { cmd, lastfmRepository } = build({ recent: [] });
    const response = await h(cmd).loveAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No recently played tracks found');
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });
});

describe('/loved', () => {
  it('renders the honest "no loved tracks" state, distinct from a failure', async () => {
    const { cmd } = build({ loved: { tracks: [], total: 0 } });
    const response = await h(cmd).lovedAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NoScrobbles);
    expect(cardText(response)).toContain('does not have any loved tracks');
  });

  it('uses the caller\'s own message when nobody is named', async () => {
    const { cmd } = build({ user: null });
    const response = await h(cmd).lovedAsync(makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Use `/login` first');
  });
});

describe('/scrobble', () => {
  it('refuses without a session key and never writes', async () => {
    const { cmd, lastfmRepository } = build({ user: { ...CALLER, sessionKey: undefined } });
    const response = await h(cmd).scrobbleAsync(
      makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NoPermission);
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('refuses a blank artist rather than scrobbling a nameless track', async () => {
    // Whitespace, not absence: both options are `required` on the builder, so
    // discord.js throws for a missing one and the only reachable `!artist` is a
    // whitespace-only value. The guard exists for that, and it must run before
    // the write.
    const { cmd, lastfmRepository } = build();
    const response = await h(cmd).scrobbleAsync(
      makeCtx({ strings: { track: 'Airbag', artist: '   ' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('both a track and artist name');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('renders an ERROR, not a confirmation, when Last.fm rejects the scrobble', async () => {
    // Same shape as the love: `scrobbleTrack` returns a boolean, so a rejected
    // write and a transport failure are indistinguishable - and neither may be
    // published as "Scrobbled ... to your Last.fm profile".
    const { cmd } = build({ scrobbleOk: false });
    const response = await h(cmd).scrobbleAsync(
      makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.Error);
    const text = cardText(response);
    expect(text).toContain('Failed to scrobble');
    expect(text).not.toContain('Scrobbled **');
  });

  it('confirms only when the repository says it wrote', async () => {
    const { cmd, lastfmRepository } = build({ scrobbleOk: true });
    const response = await h(cmd).scrobbleAsync(
      makeCtx({ strings: { track: 'Airbag', artist: 'Radiohead', album: 'OK Computer' } }),
    );

    expect(lastfmRepository.scrobbleTrack).toHaveBeenCalledWith(
      'Radiohead',
      'Airbag',
      expect.any(Number),
      'sk-abc',
      'OK Computer',
    );
    expect(cardText(response)).toContain('Scrobbled **Airbag** by **Radiohead**');
  });
});