/**
 * `/gaps`, `/discoveries`, `/iceberg`, `/affinity` - the four intelligence
 * commands, and the target resolution they share.
 *
 * THE TRUST BOUNDARY HERE IS TARGET RESOLUTION, and one of its branches is a
 * real gap worth reading before the tests.
 *
 * `resolveTarget` (`intelligenceSlashCommands.ts:148-154`) does:
 *
 *     if (targetDiscordUserId && targetDiscordUserId !== context.discordUserId) {
 *       const foundUser = await this.userService.getUserByDiscordId(targetDiscordUserId);
 *       if (foundUser) { targetUser = foundUser; displayName = foundUser.userNameLastFm; }
 *     }
 *
 * There is no `else`. A user who runs `/gaps user:@someone` and `@someone` has
 * never registered gets their OWN listening gaps, under their OWN display name,
 * with no indication the named target was dropped. Nothing printed is false -
 * which is what makes it survive a code review - but the question that was
 * asked is not the question that got answered. The branch is pinned here as
 * characterisation, NOT as endorsement, and it is reported separately.
 *
 * The rest of the file is the A1 pair, for all four commands: a source that
 * cannot be read must not render as a confident "there is nothing here". The
 * intelligence service already refuses to launder a database outage into an
 * empty array (`musicIntelligenceService.orDatabaseUnavailable` re-raises), and
 * `lastFmRepository.getTopArtists` raises `LastFmUnavailableError` for anything
 * that is not a real not-found. These tests exist to prove that raise reaches
 * the user as a raise, and that the genuine empty still renders as the genuine
 * empty - the half a blanket `catch` would break.
 *
 * Plain object doubles through the 7-argument constructor, so `container.resolve`
 * is never reached and nothing is spied on.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { IntelligenceSlashCommands } from './intelligenceSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { TimePeriod } from '@domain/enums/timePeriod';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/userService';
import type { SettingService } from '@bot/services/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { MusicIntelligenceService } from '@bot/services/musicIntelligenceService';
import type { ColorService } from '@bot/services/colorService';
import type { ArtworkService } from '@bot/services/artworkService';
import type { IcebergGenerator } from '@images/generators/icebergGenerator';

const CALLER = {
  userId: 7,
  userNameLastFm: 'DreadRock',
  discordUserId: 'caller1',
  sessionKey: 'sk',
};
const OTHER = {
  userId: 9,
  userNameLastFm: 'SomeUser',
  discordUserId: 'other1',
  sessionKey: 'sk2',
};

const LFM_DOWN = (method = 'user.gettopartists') =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 500'));

/** The failure `orDatabaseUnavailable` re-raises instead of returning `[]`. */
const DB_DOWN = () => new Error("Can't reach database server");

interface CtxSpec {
  inGuild?: boolean;
  guildName?: string;
  iconUrl?: string | null;
  displayName?: string;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const guildId = spec.inGuild === false ? undefined : '222';
  const guild = guildId
    ? {
        id: guildId,
        name: spec.guildName ?? 'Test Guild',
        iconURL: () => spec.iconUrl ?? null,
        members: { cache: { get: () => undefined } },
      }
    : null;
  return {
    discordUserId: 'caller1',
    guildId,
    guild,
    discordDisplayName: spec.displayName ?? 'Caller',
    member: { displayName: spec.displayName ?? 'Caller' },
    interaction: { channelId: 'text1', id: 'i1', guild, user: { id: 'caller1', tag: 'caller#1' } },
    userIsGuildAdmin: false,
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

interface Doubles {
  caller?: unknown;
  target?: unknown;
  period?: { timePeriod?: TimePeriod; description: string; startDateTime?: Date; endDateTime?: Date };
  gaps?: () => Promise<unknown[]>;
  discoveries?: () => Promise<unknown[]>;
  affinity?: unknown;
  affinityImpl?: () => Promise<unknown>;
  topArtists?: () => Promise<unknown[]>;
  iceberg?: unknown;
  generateIceberg?: () => Promise<Buffer>;
  artUrl?: string | null;
  colorFromUrl?: number;
}

/**
 * Constructor arity, read from `intelligenceSlashCommands.ts`:
 * (userService, settingService, lastfmRepository, intelligenceService,
 *  colorService?, icebergGenerator?, artworkService?). All seven are supplied so
 * the `container.resolve(...)` fallbacks on lines 169-170 / 215-216 / 280 / 286
 * / 324 / 328 are never taken.
 */
const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (id === 'other1') return over.target === undefined ? OTHER : over.target;
      return over.caller === undefined ? CALLER : over.caller;
    }),
  } as unknown as UserService;
  const settingService = {
    getTimePeriod: vi.fn(
      () => over.period ?? { timePeriod: TimePeriod.Quarterly, description: 'Quarterly' },
    ),
  } as unknown as SettingService;
  const lastfmRepository = {
    getTopArtists: vi.fn(over.topArtists ?? (async () => [{ name: 'Radiohead', playcount: 900 }])),
  } as unknown as LastFmRepository;
  const intelligenceService = {
    getListeningGaps: vi.fn(over.gaps ?? (async () => [])),
    getDiscoveries: vi.fn(over.discoveries ?? (async () => [])),
    getIceberg: vi.fn(async () => over.iceberg ?? {
      displayName: 'Caller',
      userNameLastFm: 'DreadRock',
      timePeriodDescription: 'Quarterly',
      tiers: [],
      totalArtists: 0,
    }),
    getGuildAffinity: vi.fn(
      over.affinityImpl ??
        (async () =>
          over.affinity ?? {
            userDisplayName: 'Caller',
            userNameLastFm: 'DreadRock',
            guildName: 'Test Guild',
            neighbors: [],
            totalGuildUsers: 0,
          }),
    ),
  } as unknown as MusicIntelligenceService;
  const colorService = {
    getColorFromImageUrl: vi.fn(async () => over.colorFromUrl ?? 0x112233),
    extractAccentColor: vi.fn(async () => 0x445566),
    getAccentColorAsync: vi.fn(async () => 0x112233),
  } as unknown as ColorService;
  const icebergGenerator = {
    generateIceberg: vi.fn(over.generateIceberg ?? (async () => Buffer.from('png-bytes'))),
  } as unknown as IcebergGenerator;
  const artworkService = {
    getArtistImageUrl: vi.fn(async () => over.artUrl === undefined ? 'https://img.test/a.jpg' : over.artUrl),
    getAlbumCoverUrl: vi.fn(async () => over.artUrl === undefined ? 'https://img.test/al.jpg' : over.artUrl),
    getTrackCoverUrl: vi.fn(async () => over.artUrl === undefined ? 'https://img.test/t.jpg' : over.artUrl),
  } as unknown as ArtworkService;

  const cmd = new IntelligenceSlashCommands(
    userService,
    settingService,
    lastfmRepository,
    intelligenceService,
    colorService,
    icebergGenerator,
    artworkService,
  );
  return {
    cmd,
    userService,
    settingService,
    lastfmRepository,
    intelligenceService,
    colorService,
    icebergGenerator,
    artworkService,
  };
};

type Handlers = {
  listeningGapsSlashAsync(c: ContextModel, t: string, target?: string): Promise<ResponseModel>;
  discoveriesSlashAsync(c: ContextModel, p: string, target?: string): Promise<ResponseModel>;
  icebergSlashAsync(c: ContextModel, p: string, target?: string): Promise<ResponseModel>;
  affinitySlashAsync(c: ContextModel, target?: string): Promise<ResponseModel>;
};
const h = (cmd: IntelligenceSlashCommands) => cmd as unknown as Handlers;

const gaps = (cmd: IntelligenceSlashCommands, ctx: ContextModel, type = 'artist', target?: string) =>
  h(cmd).listeningGapsSlashAsync(ctx, type, target);
const discoveries = (cmd: IntelligenceSlashCommands, ctx: ContextModel, period = 'quarterly', target?: string) =>
  h(cmd).discoveriesSlashAsync(ctx, period, target);
const iceberg = (cmd: IntelligenceSlashCommands, ctx: ContextModel, period = 'overall', target?: string) =>
  h(cmd).icebergSlashAsync(ctx, period, target);
const affinity = (cmd: IntelligenceSlashCommands, ctx: ContextModel, target?: string) =>
  h(cmd).affinitySlashAsync(ctx, target);

describe('IntelligenceSlashCommands target resolution', () => {
  it('refuses a caller who has never connected a Last.fm account, before any data read', async () => {
    const { cmd, intelligenceService, lastfmRepository } = build({ caller: null });
    const response = await gaps(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(intelligenceService.getListeningGaps).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('reads the NAMED user when they are registered, not the caller', async () => {
    const { cmd, intelligenceService } = build();
    await gaps(cmd, makeCtx(), 'artist', 'other1');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(9, 'artist', 90);
  });

  it('treats "my own user option" as the caller rather than a second lookup', async () => {
    const { cmd, userService, intelligenceService } = build();
    await gaps(cmd, makeCtx(), 'artist', 'caller1');

    expect(userService.getUserByDiscordId).toHaveBeenCalledTimes(1);
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(7, 'artist', 90);
  });

  it('CHARACTERISATION: an unregistered target is silently replaced by the caller', async () => {
    // See the file header. There is no `else` on the `foundUser` check, so the
    // named user vanishes and the caller's own data is rendered under the
    // caller's own name. Pinned so the behaviour is visible and so a future fix
    // has to change this test on purpose.
    const { cmd, intelligenceService } = build({ target: null });
    const response = await gaps(cmd, makeCtx(), 'artist', 'other1');

    expect(intelligenceService.getListeningGaps).toHaveBeenCalledWith(7, 'artist', 90);
    expect(cardText(response)).toContain('DreadRock');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });
});

describe('/gaps: a database outage must not render as "no listening gaps"', () => {
  it('renders the honest empty card for a user who genuinely has no gaps', async () => {
    const { cmd } = build({ gaps: async () => [] });
    const response = await gaps(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No artist listening gaps of 90+ days');
  });

  it('refuses to render that card when the gap query raises', async () => {
    // THE A1 TEST. If a `catch { return gapsEmptyResponse() }` were ever added,
    // this fails - and the failure mode it protects against is a user being
    // told their listening history has no gaps when the database was simply
    // unreachable.
    const { cmd } = build({ gaps: async () => Promise.reject(DB_DOWN()) });
    await expect(gaps(cmd, makeCtx())).rejects.toThrow(/database server/i);
  });

  it('takes the accent colour from the top artist\'s own artwork', async () => {
    const { cmd, artworkService, colorService } = build({
      gaps: async () => [
        {
          name: 'Radiohead',
          resumeDate: new Date('2026-01-02T00:00:00Z'),
          prevPlayed: new Date('2024-01-02T00:00:00Z'),
          gapDays: 730,
          totalPlays: 12,
        },
      ],
    });
    const response = await gaps(cmd, makeCtx(), 'artist');

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img.test/a.jpg');
    expect(cardText(response)).toContain('Radiohead');
  });

  it('asks for an ALBUM cover for the album gap type, not an artist image', async () => {
    const { cmd, artworkService } = build({
      gaps: async () => [
        {
          name: 'OK Computer',
          artistName: 'Radiohead',
          resumeDate: new Date('2026-01-02T00:00:00Z'),
          prevPlayed: new Date('2024-01-02T00:00:00Z'),
          gapDays: 400,
          totalPlays: 5,
        },
      ],
    });
    await gaps(cmd, makeCtx(), 'album');

    expect(artworkService.getAlbumCoverUrl).toHaveBeenCalledWith('OK Computer', 'Radiohead');
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('asks for a TRACK cover for the track gap type', async () => {
    const { cmd, artworkService } = build({
      gaps: async () => [
        {
          name: 'Airbag',
          artistName: 'Radiohead',
          resumeDate: new Date('2026-01-02T00:00:00Z'),
          prevPlayed: new Date('2024-01-02T00:00:00Z'),
          gapDays: 90,
          totalPlays: 3,
        },
      ],
    });
    await gaps(cmd, makeCtx(), 'track');

    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('Airbag', 'Radiohead');
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('keeps the default accent when no artwork could be resolved at all', async () => {
    // A null art URL is an omitted block, not a wrong colour: the card must fall
    // back to the brand red rather than sample a colour out of nothing.
    const { cmd, colorService } = build({
      artUrl: null,
      gaps: async () => [
        {
          name: 'Radiohead',
          resumeDate: new Date('2026-01-02T00:00:00Z'),
          prevPlayed: new Date('2024-01-02T00:00:00Z'),
          gapDays: 100,
          totalPlays: 2,
        },
      ],
    });
    const response = await gaps(cmd, makeCtx(), 'artist');

    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    const json = JSON.stringify(response.componentsV2Container?.toJSON());
    expect(json).toContain(String(DiscordConstants.LastFmColorRed));
  });
});

describe('/discoveries', () => {
  it('renders the honest empty for a period with no first listens', async () => {
    const { cmd } = build({ discoveries: async () => [] });
    const response = await discoveries(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No newly discovered artists found');
  });

  it('refuses to render that card when the discovery query raises', async () => {
    const { cmd } = build({ discoveries: async () => Promise.reject(DB_DOWN()) });
    await expect(discoveries(cmd, makeCtx())).rejects.toThrow(/database server/i);
  });

  it('passes the resolved window to the query rather than defaulting to today', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-04-01T00:00:00Z');
    const { cmd, intelligenceService } = build({
      period: { timePeriod: TimePeriod.Quarterly, description: 'Quarterly', startDateTime: start, endDateTime: end },
    });
    await discoveries(cmd, makeCtx(), 'quarterly');

    expect(intelligenceService.getDiscoveries).toHaveBeenCalledWith(7, start, end);
  });

  it('never reads Last.fm for this command', async () => {
    const { cmd, lastfmRepository } = build();
    await discoveries(cmd, makeCtx());
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });
});

describe('/iceberg: a Last.fm outage is not a listener with no taste', () => {
  it('renders NotFound for a Last.fm that genuinely has no top artists', async () => {
    const { cmd } = build({ topArtists: async () => [] });
    const response = await iceberg(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No top artists found');
  });

  it('refuses to say "No top artists found" when Last.fm is down', async () => {
    // THE A1 TEST. `topArtists.length === 0` is the same test the genuine empty
    // uses, so the ONLY thing separating the two is whether the raise survives.
    const { cmd } = build({ topArtists: async () => Promise.reject(LFM_DOWN()) });
    const settled = await iceberg(cmd, makeCtx()).then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(settled).toBeInstanceOf(LastFmUnavailableError);
    expect(String(settled)).not.toContain('No top artists found');
  });

  it('forwards the session key so a private profile still resolves', async () => {
    const { cmd, lastfmRepository } = build({
      period: { timePeriod: TimePeriod.AllTime, description: 'Alltime' },
    });
    await iceberg(cmd, makeCtx(), 'overall', 'other1');

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('SomeUser', TimePeriod.AllTime, 100, 1, 'sk2');
  });

  it('still renders the tier list when the image generator fails', async () => {
    // The generator is decoration, so a Puppeteer failure must cost the picture
    // and nothing else. Losing the whole card would be the worse regression.
    const { cmd, intelligenceService } = build({
      generateIceberg: async () => {
        throw new Error('chromium exploded');
      },
      iceberg: {
        displayName: 'Caller',
        userNameLastFm: 'DreadRock',
        timePeriodDescription: 'Overall',
        tiers: [
          {
            tierNumber: 1,
            name: 'Mainstream',
            emoji: '🏔️',
            description: 'Everyone knows these',
            artists: [{ name: 'Radiohead', playcount: 900 }],
          },
        ],
        totalArtists: 1,
      },
    });
    const response = await iceberg(cmd, makeCtx());

    expect(intelligenceService.getIceberg).toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Radiohead');
    expect(response.hasFile()).toBe(false);
  });

  it('samples the accent colour out of the generated image when there is one', async () => {
    const { cmd, colorService } = build();
    const response = await iceberg(cmd, makeCtx());

    expect(colorService.extractAccentColor).toHaveBeenCalled();
    const json = JSON.stringify(response.componentsV2Container?.toJSON());
    expect(json).toContain(String(0x445566));
  });
});

describe('/affinity', () => {
  it('refuses in a DM instead of answering with an empty neighbour list', async () => {
    const { cmd, intelligenceService } = build();
    const response = await affinity(cmd, makeCtx({ inGuild: false }));

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(cardText(response)).toContain('can only be used in a server');
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
  });

  it('renders the honest empty when no server member is indexed', async () => {
    const { cmd } = build();
    const response = await affinity(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Could not find indexed users with a similar music taste');
  });

  it('refuses to render that card when the affinity query raises', async () => {
    const { cmd } = build({
      affinityImpl: async () => {
        throw DB_DOWN();
      },
    });
    await expect(affinity(cmd, makeCtx())).rejects.toThrow(/database server/i);
  });

  it('passes the resolved guild NAME so the card does not say "this server"', async () => {
    const { cmd, intelligenceService } = build();
    await affinity(cmd, makeCtx({ guildName: 'Loud Room' }));

    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledWith(
      '222',
      7,
      'Caller',
      'DreadRock',
      'Loud Room',
    );
  });

  it('falls back to the brand red when the server has no icon', async () => {
    // The icon arrives through the CONTEXT, not through a service double:
    // `intelligenceSlashCommands.ts:325` reads `context.guild?.iconURL({size:
    // 256})`, and `CtxSpec.iconUrl` is what feeds that. Putting `iconUrl` on
    // `Doubles` would have claimed a knob the fixture factory never reads, and
    // the assertion would have passed whatever production did.
    const { cmd, colorService } = build();
    await affinity(cmd, makeCtx({ iconUrl: null }));
    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
  });

  it('takes the accent from the server icon when there is one', async () => {
    // The other half of the branch above, and the reason that one is a claim at
    // all: `makeCtx` already defaults the icon to null, so without this the
    // previous test also passed if production never read the icon.
    const { cmd, colorService } = build();
    await affinity(cmd, makeCtx({ iconUrl: 'https://cdn.test/icon.png' }));
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn.test/icon.png');
  });
});