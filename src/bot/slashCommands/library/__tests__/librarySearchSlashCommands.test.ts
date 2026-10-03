import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LibrarySearchSlashCommands } from '@bot/slashCommands/library/librarySearchSlashCommands';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { SearchTab } from '@bot/services/library/librarySearchService';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';

vi.mock('@bot/handlers/commands/commandGuards', () => ({
  ensureLinkedUser: vi.fn(),
}));

vi.mock('@bot/interactions/library/librarySearchInteractions', () => ({
  storeSearchQuery: vi.fn(),
}));

import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';
import { LibrarySearchBuilders } from '@bot/builders/library/librarySearchBuilders';
import { storeSearchQuery } from '@bot/interactions/library/librarySearchInteractions';

const mkUser = (over: Partial<User> = {}): User =>
  ({
    userId: 7,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const mkContext = (query: string, over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '/',
    interaction: { options: { getString: () => query } },
    ...over,
  }) as unknown as ContextModel;

const build = () => {
  const userService = { getUserByDiscordId: vi.fn() } as never;
  const searchService = { search: vi.fn(async () => [{ primary: 'X', count: 1 }]) };
  const colorService = { getAccentColorAsync: vi.fn(async () => 0x445566) };
  const mod = new LibrarySearchSlashCommands(
    userService as never,
    searchService as never,
    colorService as never,
  );
  return { mod, userService, searchService, colorService };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchdb slash contract', () => {
  it('keeps name searchdb and mentions .librarysearch as the text twin', () => {
    const { mod } = build();
    expect(mod.commands).toHaveLength(1);
    expect(mod.commands[0]!.data.name).toBe('searchdb');
    const desc = (mod.commands[0]!.data.toJSON() as { description?: string }).description ?? '';
    expect(desc).toContain('.librarysearch');
    expect(desc.length).toBeLessThanOrEqual(100);
  });

  it('rejects empty query without touching the guard', async () => {
    const { mod } = build();
    const res = await mod.commands[0]!.executeAsync(mkContext('   '));
    expect(res.commandResponse).toBe(CommandResponse.WrongInput);
    expect(ensureLinkedUser).not.toHaveBeenCalled();
  });

  it('returns the guard response when unlinked and never searches', async () => {
    const { mod, searchService } = build();
    const guardRes = new ResponseModel();
    guardRes.commandResponse = CommandResponse.NotFound;
    vi.mocked(ensureLinkedUser).mockResolvedValueOnce(guardRes as never);
    const res = await mod.commands[0]!.executeAsync(mkContext('radiohead'));
    expect(res).toBe(guardRes);
    expect(searchService.search).not.toHaveBeenCalled();
  });

  it('passes slash:true to the guard', async () => {
    const { mod } = build();
    vi.mocked(ensureLinkedUser).mockResolvedValueOnce(mkUser() as never);
    vi.spyOn(LibrarySearchBuilders, 'buildSearchResponse').mockReturnValueOnce({ ok: 1 } as never);
    await mod.commands[0]!.executeAsync(mkContext('radiohead'));
    expect(ensureLinkedUser).toHaveBeenCalledWith(expect.anything(), '111', { slash: true });
  });

  it('searches the linked user Tracks tab and returns the builder card', async () => {
    const { mod, searchService } = build();
    vi.mocked(ensureLinkedUser).mockResolvedValueOnce(mkUser() as never);
    const card = new ResponseModel();
    const spy = vi.spyOn(LibrarySearchBuilders, 'buildSearchResponse').mockReturnValueOnce(card);
    const res = await mod.commands[0]!.executeAsync(mkContext('radiohead'));
    expect(searchService.search).toHaveBeenCalledWith(7, 'radiohead', SearchTab.Tracks);
    expect(storeSearchQuery).toHaveBeenCalledWith(expect.any(String), 'radiohead', 7);
    expect(spy).toHaveBeenCalledOnce();
    expect(res).toBe(card);
  });
});
