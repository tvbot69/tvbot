import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LibrarySearchCommands } from '@bot/textCommands/lastfm/librarySearchCommands';
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
    userId: 42,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    ...over,
  }) as unknown as ContextModel;

const build = () => {
  const userService = { getUserByDiscordId: vi.fn() } as never;
  const searchService = { search: vi.fn(async () => [{ primary: 'X', count: 1 }]) };
  const colorService = { getAccentColorAsync: vi.fn(async () => 0x112233) };
  const mod = new LibrarySearchCommands(
    userService as never,
    searchService as never,
    colorService as never,
  );
  return { mod, userService, searchService, colorService };
};

const run = (mod: LibrarySearchCommands, context: ContextModel, raw: string) =>
  mod.commands[0]!.executeAsync(context, raw.split(' ').filter(Boolean));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('librarysearch text contract', () => {
  it('keeps canonical name librarysearch with existing aliases', () => {
    const { mod } = build();
    expect(mod.commands).toHaveLength(1);
    expect(mod.commands[0]!.name).toBe('librarysearch');
    expect([...(mod.commands[0]!.aliases ?? [])].sort()).toEqual(
      ['dbsearch', 'libsearch', 'ls', 'searchdb'].sort(),
    );
  });

  it('rejects empty query without touching the guard', async () => {
    const { mod } = build();
    const res = await run(mod, mkContext(), '');
    expect(res.commandResponse).toBe(CommandResponse.WrongInput);
    expect(ensureLinkedUser).not.toHaveBeenCalled();
  });

  it('returns the guard response when unlinked and never searches', async () => {
    const { mod, searchService } = build();
    const guardRes = new ResponseModel();
    guardRes.commandResponse = CommandResponse.NotFound;
    vi.mocked(ensureLinkedUser).mockResolvedValueOnce(guardRes as never);
    const res = await run(mod, mkContext(), 'daft punk');
    expect(res).toBe(guardRes);
    expect(searchService.search).not.toHaveBeenCalled();
  });

  it('passes the text prefix to the guard', async () => {
    const { mod } = build();
    vi.mocked(ensureLinkedUser).mockResolvedValueOnce(mkUser() as never);
    vi.spyOn(LibrarySearchBuilders, 'buildSearchResponse').mockReturnValueOnce({ ok: 1 } as never);
    await run(mod, mkContext({ prefix: '!' }), 'daft punk');
    expect(ensureLinkedUser).toHaveBeenCalledWith(expect.anything(), '111', { prefix: '!' });
  });

  it('searches the linked user Tracks tab and returns the builder card', async () => {
    const { mod, searchService } = build();
    vi.mocked(ensureLinkedUser).mockResolvedValueOnce(mkUser() as never);
    const card = new ResponseModel();
    const spy = vi.spyOn(LibrarySearchBuilders, 'buildSearchResponse').mockReturnValueOnce(card);
    const res = await run(mod, mkContext(), 'daft punk');
    expect(searchService.search).toHaveBeenCalledWith(42, 'daft punk', SearchTab.Tracks);
    expect(storeSearchQuery).toHaveBeenCalledWith(expect.any(String), 'daft punk', 42);
    expect(spy).toHaveBeenCalledOnce();
    expect(res).toBe(card);
  });
});
