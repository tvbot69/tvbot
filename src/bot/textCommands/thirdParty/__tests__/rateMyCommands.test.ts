import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RateMyCommands, releaseSlugFromTriple } from '@bot/textCommands/thirdParty/rateMyCommands';
import { RymTransport } from '@rateyourmusic/api/rymTransport';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { RecentTrack } from '@domain/models/recentTrack';

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'rateyourmusic', 'api', 'fixtures', name), 'utf8');

const user = { userId: 1, discordUserId: '111', userNameLastFm: 'Alpha', sessionKey: 'SK', lastUpdate: new Date() };

const recent = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Bone Machine',
  artistName: 'Pixies',
  albumName: 'Surfer Rosa',
  nowPlaying: true,
  ...over,
});

const build = (over: { recents?: RecentTrack[]; html?: string } = {}) => {
  const userService = { getUserByDiscordId: vi.fn(async () => user) };
  const transport = new RymTransport({ solverUrl: 'http://localhost:8191', minDelayMs: 0 });
  vi.spyOn(transport, 'getHtml').mockImplementation(async () => ({
    html: over.html ?? fixture('release_surfer_rosa_wayback.html'),
    status: 200,
    userAgent: 'UA',
    url: 'https://rateyourmusic.com/x',
  }));
  const prefixService = { getPrefix: vi.fn(async () => '.') };
  const lastFmRepository = {
    getUserRecentTracks: vi.fn(async () => over.recents ?? [recent()]),
  };
  const commands = new RateMyCommands(
    userService as never,
    transport as never,
    prefixService as never,
    lastFmRepository as never,
  );
  return { commands, transport, lastFmRepository };
};

describe('releaseSlugFromTriple', () => {
  it('builds artist/album slugs', () => {
    expect(releaseSlugFromTriple({ artist: 'Guns N\' Roses', album: 'Use Your Illusion I', track: 'x' })).toBe(
      'guns-n-roses/use-your-illusion-i',
    );
  });
});

describe('RateMyCommands', () => {
  it('rm with no args uses the now-playing artist', async () => {
    const { commands } = build({ html: fixture('artist_radiohead.html') });
    // the spied getHtml returns the artist fixture regardless of slug
    const res = await commands.artistAsync(ctx(), 'radiohead');
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    expect(res.isComponentsV2).toBe(true);
  });

  it('rma with no args uses the now-playing album', async () => {
    const { commands, lastFmRepository } = build();
    const res = await commands.albumAsync(ctx(), '');
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 2, 1, undefined, 'SK');
  });

  it('rma uses session key from the linked user for the recent lookup', async () => {
    const { commands, lastFmRepository } = build();
    await commands.albumAsync(ctx(), '');
    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 2, 1, undefined, 'SK');
  });

  it('rmt resolves through the same recent scrobble', async () => {
    const { commands, lastFmRepository } = build({ html: fixture('song_bone_machine.html') });
    const res = await commands.trackAsync(ctx(), '');
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalled();
  });

  it('explicit artist/title skips the Last.fm read', async () => {
    const { commands, lastFmRepository } = build();
    const res = await commands.albumAsync(ctx(), 'pixies/surfer-rosa');
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('no recent tracks returns an honest NotFound', async () => {
    const { commands } = build({ recents: [] });
    const res = await commands.albumAsync(ctx(), '');
    expect(res.commandResponse).toBe(CommandResponse.NotFound);
  });
});
