import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TrackCommands } from './trackCommands';
import { TrackBuilders } from '@bot/builders/trackBuilders';
import { TrackDetailsBuilders } from '@bot/builders/trackDetailsBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { previewMap } from '@bot/services/audio/voiceMessageService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';

/**
 * `.track` and `.trackdetails` — the two card commands in the track family.
 *
 * Three failure directions are guarded, in both directions each:
 *
 *  1. **A mention that resolves to nobody.** `.track <@333> x` must not fall
 *     back to the caller. A silent fallback answers a question about one person
 *     with another person's playcounts, which is the worst shape a bug can take
 *     here: there is nothing on the card to notice.
 *  2. **A failed metadata enrichment.** `getDetails` reaches Spotify, Apple,
 *     Deezer, a preview download and an audio-analysis pass. It is caught and
 *     turned into `mediaDetails: null`, which is right — but only because every
 *     playcount on the card came from `searchTrack`, before the catch. The test
 *     asserts the card is still built AND that the builder receives null, so a
 *     refactor that moved the search inside the catch would fail here.
 *  3. **An absent `ColorService`.** The constructor takes it as an optional
 *     trailing collaborator, so `?? DiscordConstants.LastFmColorRed` is a live
 *     branch rather than dead defensive code.
 *
 * `trackDetailsAsync` is the noisier twin and has one behaviour worth naming:
 * a Last.fm search that finds NOTHING still proceeds, labelling the card
 * "Unknown Artist" and the user's raw text as a track name. The test is named
 * for what it pins rather than endorsed.
 */

const user = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    accentColor: 0x445566,
    message: {
      channelId: 'C1',
      author: { id: '111', username: 'caller', displayName: 'Caller' },
      member: { displayName: 'Caller' },
      guild: {
        name: 'Test Guild',
        members: { cache: new Map<string, { displayName: string }>(), fetch: vi.fn(async () => null) },
      },
    },
    ...over,
  }) as unknown as ContextModel;

const trackResult = (over: Record<string, unknown> = {}) => ({
  trackName: 'Airbag',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  coverUrl: 'https://img/cover.png',
  userPlaycount: 400,
  ...over,
});

const details = (over: Record<string, unknown> = {}) => ({
  trackName: 'Airbag',
  artistName: 'Radiohead',
  durationMs: 284000,
  durationFormatted: '4:44',
  bpm: 116,
  key: 'C#',
  previewUrl: 'https://preview/abc.mp3',
  storeUrl: 'https://store/abc',
  artworkUrl: 'https://img/details.png',
  spotifyUrl: 'https://open.spotify.com/track/abc',
  resolved: { source: 'spotify' },
  ...over,
});

type Over = {
  caller?: User | null;
  mentioned?: User | null;
  searchResult?: unknown;
  detailsResult?: unknown;
  detailsThrows?: unknown;
  withColorService?: boolean;
  withLyricsService?: boolean;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...a: unknown[]) => {
      const id = a[0] as string;
      if (id !== '111') return (over.mentioned ?? null) as User | null;
      return over.caller === undefined ? user() : over.caller;
    }),
  };
  const trackService = { searchTrack: vi.fn(async () => (over.searchResult === undefined ? trackResult() : over.searchResult)) };
  const trackDetailsService = {
    getDetails: vi.fn(async (..._args: unknown[]) => {
      if (over.detailsThrows) throw over.detailsThrows;
      return over.detailsResult === undefined ? details() : over.detailsResult;
    }),
  };
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) => [] as RecentTrack[]),
    searchTracks: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  };
  const updateService = { updateUser: vi.fn(async (..._a: unknown[]) => undefined) };
  const colorService = { getColorFromImageUrl: vi.fn(async (..._a: unknown[]) => 0x112233) };

  const commands = new TrackCommands(
    userService as never,
    trackService as never,
    trackDetailsService as never,
    lastfmRepository as never,
    updateService as never,
    undefined,
    over.withColorService === false ? undefined : (colorService as never),
  );
  return { commands, userService, trackService, trackDetailsService, lastfmRepository, updateService, colorService };
};

const priv = (c: TrackCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>>;

const track = (c: TrackCommands, args: string[], context: ContextModel = ctx()) =>
  priv(c)['trackAsync']!.bind(c)(context, args);
const trackDetails = (c: TrackCommands, raw: string, context: ContextModel = ctx()) =>
  priv(c)['trackDetailsAsync']!.bind(c)(context, raw);

const desc = (r: unknown): string => (r as { embed: { data: { description?: string } } }).embed.data.description ?? '';

beforeEach(() => {
  vi.restoreAllMocks();
  previewMap.clear();
  vi.spyOn(TrackBuilders, 'buildTrackInfoResponse').mockReturnValue({ marker: 'info' } as never);
  vi.spyOn(TrackBuilders, 'buildLoveResponse').mockReturnValue({ marker: 'love' } as never);
  vi.spyOn(TrackDetailsBuilders, 'buildTrackDetailsResponse').mockReturnValue({ marker: 'details' } as never);
  vi.spyOn(TrackDetailsBuilders, 'buildNoMetadataResponse').mockReturnValue({ marker: 'nometa' } as never);
});

describe('.track — a mention that resolves to nobody must not become the caller', () => {
  it('refuses a mention whose target has not registered', async () => {
    const { commands, trackService } = build({ mentioned: null });

    const result = await track(commands, ['<@333>', 'airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('not registered');
    // The whole point: the caller's own playcounts must never answer a
    // question that was asked about somebody else.
    expect(trackService.searchTrack).not.toHaveBeenCalled();
  });

  it('refuses the nickname mention form too', async () => {
    const { commands, trackService } = build({ mentioned: null });

    const result = await track(commands, ['<@!333>']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(trackService.searchTrack).not.toHaveBeenCalled();
  });

  it('refuses when the caller themselves has not connected an account', async () => {
    const { commands, trackService } = build({ caller: null });

    const result = await track(commands, ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(trackService.searchTrack).not.toHaveBeenCalled();
  });

  it('searches as the mentioned user, not as the caller', async () => {
    const { commands, trackService } = build({ mentioned: user({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) });

    await track(commands, ['<@999>', 'airbag']);

    const [query, searched, guildId] = (trackService.searchTrack as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(query).toBe('airbag');
    expect((searched as User).userId).toBe(7);
    expect(guildId).toBe('222');
  });

  it('strips the mention out of the search string', async () => {
    const { commands, trackService } = build({ mentioned: user({ userId: 7 }) });

    await track(commands, ['<@999>', 'weird', 'fishes']);

    expect((trackService.searchTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('weird fishes');
  });

  it('labels the card with the mentioned member’s nickname when the fetch succeeds', async () => {
    const { commands } = build({ mentioned: user({ userId: 7 }) });
    const context = ctx({
      message: {
        channelId: 'C1',
        author: { id: '111', username: 'caller', displayName: 'Caller' },
        member: { displayName: 'Caller' },
        guild: {
          name: 'Test Guild',
          members: { cache: new Map(), fetch: vi.fn(async () => ({ displayName: 'Beta' })) },
        },
      },
    });

    await track(commands, ['<@999>', 'airbag'], context);

    expect(vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![2]).toBe('Beta');
  });

  it('falls back to the message member’s name when the member fetch throws, rather than failing the card', async () => {
    // The member fetch is a DISCORD read whose only product is a label. Losing
    // the nickname costs cosmetically less specificity and nothing else.
    const { commands } = build({ mentioned: user({ userId: 7 }) });
    const context = ctx({
      message: {
        channelId: 'C1',
        author: { id: '111', username: 'caller', displayName: 'Caller' },
        member: { displayName: 'Caller' },
        guild: {
          name: 'Test Guild',
          members: { cache: new Map(), fetch: vi.fn(async () => { throw new Error('Missing Permissions'); }) },
        },
      },
    });

    const result = await track(commands, ['<@999>', 'airbag'], context);

    expect(result).toEqual({ marker: 'info' });
    expect(vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![2]).toBe('Caller');
  });

  it('falls all the way back to the Last.fm name with no Discord context at all', async () => {
    const { commands } = build({ mentioned: user({ userId: 7, userNameLastFm: 'Beta' }) });

    await track(commands, ['<@999>', 'airbag'], ctx({ message: undefined }));

    expect(vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![2]).toBe('Beta');
  });
});

describe('.track — a failed metadata read costs the preview, not the numbers', () => {
  it('still builds the card when the enrichment raises', async () => {
    const { commands } = build({ detailsThrows: new Error('preview resolver timed out') });

    const result = await track(commands, ['airbag']);

    expect(result).toEqual({ marker: 'info' });
  });

  it('hands the builder a null media payload, so no preview button is offered', async () => {
    const { commands } = build({ detailsThrows: new LastFmUnavailableError('track.getInfo', new Error('Last.fm 5xx')) });

    await track(commands, ['airbag']);

    const [, searchedUser, displayName, , mediaDetails] =
      vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]!;
    expect(mediaDetails).toBeNull();
    // The search result is the thing that carried every playcount, and it is
    // resolved before the catch, so those numbers survive intact.
    expect((searchedUser as User).userNameLastFm).toBe('Alpha');
    expect(displayName).toBe('Caller');
  });

  it('registers the preview only when there is one to register', async () => {
    const { commands } = build({ detailsResult: details({ previewUrl: 'https://preview/abc.mp3' }) });

    await track(commands, ['airbag']);

    expect([...previewMap.values()]).toEqual(['https://preview/abc.mp3']);
  });

  it('registers nothing when the provider resolved a track with no preview', async () => {
    // No preview means no 30-second sample; a stale entry under a fresh unique
    // id would be a button that plays the wrong thing.
    const { commands } = build({ detailsResult: details({ previewUrl: null }) });

    await track(commands, ['airbag']);

    expect(previewMap.size).toBe(0);
  });

  it('registers the preview under the same id the card carries', async () => {
    // The preview is claimed by a button later, so the id handed to
    // `getDetails`, the id on the media payload and the previewMap key must all
    // be one string.
    const { commands, trackDetailsService } = build();

    await track(commands, ['airbag']);

    const uniqueId = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(uniqueId.startsWith('track_111_')).toBe(true);
    expect((vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![4] as { uniqueId: string }).uniqueId).toBe(uniqueId);
    expect(previewMap.get(uniqueId)).toBe('https://preview/abc.mp3');
  });

  it('passes only the fields the card can actually render', async () => {
    const { commands } = build();

    await track(commands, ['airbag']);

    expect(vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![4]).toEqual({
      uniqueId: expect.stringMatching(/^track_111_/),
      previewUrl: 'https://preview/abc.mp3',
      storeUrl: 'https://store/abc',
      spotifyUrl: 'https://open.spotify.com/track/abc',
      source: 'spotify',
      durationFormatted: '4:44',
    });
  });
});

describe('.track — colour, staleness and the no-argument path', () => {
  it('uses the colour extracted from the resolved cover', async () => {
    const { commands, colorService } = build();

    await track(commands, ['airbag']);

    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/cover.png');
    expect(vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![3]).toBe(0x112233);
  });

  it('falls back to the Last.fm red when no colour service is wired', async () => {
    // The collaborator is optional in the constructor, so this branch runs
    // whenever wiring is partial — it must degrade, not throw.
    const { commands } = build({ withColorService: false });

    const result = await track(commands, ['airbag']);

    expect(vi.mocked(TrackBuilders.buildTrackInfoResponse).mock.calls[0]![3]).toBe(DiscordConstants.LastFmColorRed);
    expect(result).toEqual({ marker: 'info' });
  });

  it('asks for the now-playing track when no arguments are given', async () => {
    const { commands, trackService } = build();

    await track(commands, []);

    // `null`, not `''`: the empty string is a search for the empty string.
    expect((trackService.searchTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeNull();
  });

  it('reports an unresolvable track instead of rendering an empty card', async () => {
    const { commands, trackDetailsService } = build({ searchResult: null });

    const result = await track(commands, ['zzzznotatrack']);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('artist');
    expect(trackDetailsService.getDetails).not.toHaveBeenCalled();
  });

  it('queues a delta sync for a stale account', async () => {
    const { commands, updateService } = build({
      caller: user({ lastUpdate: new Date(Date.now() - 60 * 60 * 1000) }),
    });

    await track(commands, ['airbag']);

    expect(updateService.updateUser).toHaveBeenCalledWith(1, { accurateTotal: true });
  });

  it('does not queue a sync for an account synced a minute ago', async () => {
    const { commands, updateService } = build({ caller: user({ lastUpdate: new Date() }) });

    await track(commands, ['airbag']);

    expect(updateService.updateUser).not.toHaveBeenCalled();
  });
});

describe('.trackdetails — the hand-written argument grammar', () => {
  it('splits on the pipe, in artist-then-track order', async () => {
    const { commands, trackDetailsService } = build();

    await trackDetails(commands, 'Radiohead | Airbag');

    const [artist, name] = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
  });

  it('splits on " by " in track-then-artist order, whatever the case', async () => {
    const { commands, trackDetailsService } = build();

    await trackDetails(commands, 'Airbag BY Radiohead');

    const [artist, name] = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
  });

  it('falls back to a Last.fm search for a bare query, and uses the first hit', async () => {
    const { commands, lastfmRepository, trackDetailsService } = build();
    (lastfmRepository.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { artistName: 'Radiohead', name: 'Airbag' },
    ]);

    await trackDetails(commands, 'airbag');

    expect(lastfmRepository.searchTracks).toHaveBeenCalledWith('airbag');
    const [artist, name] = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
  });

  it('CURRENT BEHAVIOUR, a search that finds nothing is answered with an "Unknown Artist" card', async () => {
    // NOT endorsed. A query Last.fm does not know produces a metadata card for
    // a fictional artist, which is a confident answer to a question that had
    // none. Pinned so a future fix is a visible diff, and so nobody reads the
    // existing behaviour as intentional. The sibling commands (`love`,
    // `scrobble`) answer the same empty search with a NotFound.
    const { commands, trackDetailsService } = build();

    const result = await trackDetails(commands, 'zzzznotatrack');

    const [artist, name] = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Unknown Artist');
    expect(name).toBe('zzzznotatrack');
    expect(result).toEqual({ marker: 'details' });
  });

  it('uses the most recent track when no query is given', async () => {
    const { commands, lastfmRepository, trackDetailsService } = build();
    (lastfmRepository.getUserRecentTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: false },
    ]);

    await trackDetails(commands, '');

    // The session key is passed so PRIVATE scrobbles are included; omitting it
    // silently under-counts for anyone with a private library.
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 1, 1, undefined, 'SK');
    const [artist, name] = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
  });

  it('reports an empty recent history rather than describing the command’s own name', async () => {
    const { commands, trackDetailsService } = build();

    const result = await trackDetails(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('No recent tracks');
    expect(trackDetailsService.getDetails).not.toHaveBeenCalled();
  });

  it('refuses for an unregistered caller before any Last.fm read', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await trackDetails(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });
});

describe('.trackdetails — resolved versus unresolved', () => {
  it('renders the full card when a provider resolved the track', async () => {
    const { commands } = build();

    const result = await trackDetails(commands, 'airbag');

    expect(result).toEqual({ marker: 'details' });
    expect(TrackDetailsBuilders.buildNoMetadataResponse).not.toHaveBeenCalled();
  });

  it('renders the honest "no metadata" card when nothing resolved', async () => {
    // A track that exists but has no preview anywhere IS a real answer, and it
    // must not be dressed up with the bpm/key block it does not have.
    const { commands } = build({ detailsResult: details({ resolved: null, bpm: null, key: null }) });

    const result = await trackDetails(commands, 'airbag');

    expect(result).toEqual({ marker: 'nometa' });
    expect(TrackDetailsBuilders.buildTrackDetailsResponse).not.toHaveBeenCalled();
  });

  it('colours the card from the artwork the details read returned', async () => {
    const { commands, colorService } = build();

    await trackDetails(commands, 'airbag');

    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/details.png');
  });

  it('lets a failed details read raise, unlike .track, which catches it', async () => {
    // The asymmetry is real: `.track` degrades to a card without a preview,
    // `.trackdetails` has nothing left to show and so propagates. Both are
    // defensible; the point is that they are different, and a test that assumes
    // they behave alike would be wrong in one direction or the other.
    const { commands } = build({ detailsThrows: new Error('preview resolver timed out') });

    await expect(trackDetails(commands, 'airbag')).rejects.toThrow(/preview resolver timed out/);
    expect(TrackDetailsBuilders.buildNoMetadataResponse).not.toHaveBeenCalled();
  });
});

describe('the track triggers reach those bodies through the registry', () => {
  it('routes `t` and `ti` to the same handler as `track`', async () => {
    const { commands, trackService } = build();

    const cmd = commands.commands.find((c) => c.name === 'track')!;
    // `track` is the command's NAME; the registry holds only the short forms as
    // aliases, so the full list is asserted rather than a hand-picked subset —
    // that way a dropped or renamed alias fails here instead of silently
    // becoming unreachable.
    expect(cmd.aliases).toEqual(['t', 'tr', 'trackinfo', 'ti']);
    // One body for all of them: the alias the user typed cannot change which
    // query runs. Three invocations, three searches.
    for (let i = 0; i < 3; i += 1) {
      await cmd.executeAsync(ctx(), ['airbag']);
    }

    expect(trackService.searchTrack).toHaveBeenCalledTimes(3);
  });

  it('routes `td` to the details body with its arguments joined', async () => {
    const { commands, trackDetailsService } = build();
    const cmd = commands.commands.find((c) => c.name === 'trackdetails')!;

    await cmd.executeAsync(ctx(), ['Radiohead', '|', 'Airbag']);

    const [artist, name] = (trackDetailsService.getDetails as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(artist).toBe('Radiohead');
    expect(name).toBe('Airbag');
  });
});
