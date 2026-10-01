import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CrownSlashCommands } from '@bot/slashCommands/crown/crownSlashCommands';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';

/**
 * `/crownseed` claimed to be admin-only and was not.
 *
 * The command's own description reads "Admin command to seed/refresh crowns for
 * this server", and the repository behind it is destructive: `seedCrownsForGuild`
 * issues `userCrown.deleteMany({ seededCrown: true })` for the whole guild
 * before re-inserting from a `DISTINCT ON` scan. The handler checked
 * `guildId` and nothing else, so any member who could type `/crownseed` could
 * wipe and rebuild the server's seeded crowns at any threshold they liked.
 *
 * The text twin `.crownseed` had the same hole and is gated now too
 * (textCommands/guild/crownCommands.ts, covered by
 * textCommands/guild/crownCommands.test.ts). These are the two halves of one
 * invariant, so both directions are asserted here: a non-admin is refused AND
 * `seedCrowns` is never reached; an admin still gets the full behaviour with
 * the option's default and the option's own value.
 *
 * Constructor arity is 7, positional, and un-decorated (no `@inject`), so the
 * doubles are passed by position in the declared order:
 *   userService, crownService, lastfmRepo, artistsService, updateService,
 *   colorService, artworkService
 */

const build = (seedResult = 0) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => null),
    getUserByLastFmName: vi.fn(async () => null),
  };
  const crownService = {
    seedCrowns: vi.fn(async () => seedResult),
    getUserCrowns: vi.fn(async () => []),
    getCurrentCrown: vi.fn(async () => null),
    getCrownHistory: vi.fn(async () => []),
    getGuildLeaderboard: vi.fn(async () => ({ entries: [], totalActiveCrowns: 0 })),
  };
  const lastfmRepo = { getUserRecentTracks: vi.fn(async () => []) };
  const artistsService = { getArtistInfo: vi.fn(async () => null) };
  const updateService = { updateUser: vi.fn(async () => undefined) };
  const colorService = { getColorFromImageUrl: vi.fn(async () => undefined) };
  const artworkService = { getArtistImageUrl: vi.fn(async () => undefined) };

  const service = new CrownSlashCommands(
    userService as never,
    crownService as never,
    lastfmRepo as never,
    artistsService as never,
    updateService as never,
    colorService as never,
    artworkService as never,
  );
  return { service, crownService };
};

const options = (o: Record<string, number | null> = {}) => ({
  getUser: () => null,
  getString: () => null,
  getInteger: (n: string) => (n in o ? (o[n] as number | null) : null),
});

const ctx = (over: Record<string, unknown> = {}, optValues: Record<string, number | null> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '/',
    guild: { name: 'Test Guild', members: { cache: { get: () => undefined } } },
    interaction: { channelId: 'text-1', id: 'i1', options: options(optValues) },
    userIsGuildAdmin: false,
    ...over,
  }) as unknown as ContextModel;

const privates = (service: CrownSlashCommands) =>
  service as unknown as {
    crownSeedAsync: (c: ContextModel) => Promise<ResponseModel>;
  };

beforeEach(() => {
  vi.spyOn(GenericEmbedService, 'buildWrongInputResponse').mockReturnValue({
    commandResponse: CommandResponse.WrongInput,
  } as never);
  vi.spyOn(GenericEmbedService, 'buildSuccessResponse').mockReturnValue({
    commandResponse: CommandResponse.Ok,
  } as never);
});

describe('CrownSlashCommands.crownSeedAsync admin gate', () => {
  it('refuses a non-admin and never reaches seedCrowns', async () => {
    const { service, crownService } = build();
    const result = await privates(service).crownSeedAsync(ctx({ userIsGuildAdmin: false }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(crownService.seedCrowns).not.toHaveBeenCalled();
  });

  it('refuses a non-admin even when a min_plays override is supplied', async () => {
    // The option must not be a way round the gate: reading it first and
    // seeding afterwards would keep the hole open for anyone who typed it.
    const { service, crownService } = build();
    const result = await privates(service).crownSeedAsync(
      ctx({ userIsGuildAdmin: false }, { min_plays: 1 }),
    );
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(crownService.seedCrowns).not.toHaveBeenCalled();
  });

  it('still refuses outside a guild, ahead of the admin check', async () => {
    const { service, crownService } = build();
    const result = await privates(service).crownSeedAsync(
      ctx({ userIsGuildAdmin: true, guildId: undefined }),
    );
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(crownService.seedCrowns).not.toHaveBeenCalled();
  });

  it('seeds with the default threshold of 30 when an admin omits min_plays', async () => {
    const { service, crownService } = build(7);
    const result = await privates(service).crownSeedAsync(ctx({ userIsGuildAdmin: true }));
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(crownService.seedCrowns).toHaveBeenCalledWith('222', 30);
    expect(GenericEmbedService.buildSuccessResponse).toHaveBeenCalledWith(
      expect.stringContaining('7'),
    );
  });

  it('seeds with the admin-supplied threshold', async () => {
    const { service, crownService } = build(3);
    const result = await privates(service).crownSeedAsync(
      ctx({ userIsGuildAdmin: true }, { min_plays: 50 }),
    );
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(crownService.seedCrowns).toHaveBeenCalledWith('222', 50);
  });
});
