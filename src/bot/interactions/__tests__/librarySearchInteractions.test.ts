import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  LibrarySearchInteractions,
  storeSearchQuery,
  getCachedSearchQuery,
} from '../librarySearchInteractions';
import { LibrarySearchBuilders } from '@bot/builders/librarySearchBuilders';
import { SearchTab } from '@bot/services/librarySearchService';
import type { SearchResultRow } from '@bot/services/librarySearchService';
import type { ButtonInteraction } from 'discord.js';

// The search session lives in a module-level TtlStore, so every test uses its
// own cache key rather than sharing one entry.
let keySeq = 0;
const nextKey = () => `sess${++keySeq}`;

const makeRows = (count = 3): SearchResultRow[] =>
  Array.from({ length: count }, (_, i) => ({
    primary: `Row ${i + 1}`,
    secondary: `Artist ${i + 1}`,
    count: 10 - i,
  }));

const makeButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    user: { id: 'caller1' },
    guildId: 'g1',
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const searchService = {
    search: vi.fn(async () => makeRows()),
    ...(over.searchService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0x00ff00),
    ...(over.colorService as object),
  };
  const lsi = new LibrarySearchInteractions(searchService as never, colorService as never);
  return { lsi, searchService, colorService };
};

const PAGE_ID = (key: string, tab: SearchTab, page: number, user = 'caller1') =>
  `search:page:${key}:${tab}:${page}:${user}`;
const TAB_ID = (key: string, tab: SearchTab, user = 'caller1') => `search:tab:${key}:${tab}:${user}`;

let builderSpy: MockInstance<typeof LibrarySearchBuilders.buildSearchResponse>;

beforeEach(() => {
  vi.restoreAllMocks();
  builderSpy = vi
    .spyOn(LibrarySearchBuilders, 'buildSearchResponse')
    .mockReturnValue({ toMessagePayload: () => ({ components: [] }) } as unknown as ReturnType<
      typeof LibrarySearchBuilders.buildSearchResponse
    >);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storeSearchQuery / getCachedSearchQuery', () => {
  it('round-trips a stored query', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);

    const cached = await getCachedSearchQuery(key);

    expect(cached).toBeDefined();
    expect(cached!.query).toBe('radiohead');
    expect(cached!.userId).toBe(42);
  });

  it('returns undefined for a key that was never stored', async () => {
    await expect(getCachedSearchQuery(`${nextKey()}-missing`)).resolves.toBeUndefined();
  });

  it('overwrites the previous query for the same key', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'first', 1);
    storeSearchQuery(key, 'second', 2);

    const cached = await getCachedSearchQuery(key);

    expect(cached!.query).toBe('second');
    expect(cached!.userId).toBe(2);
  });
});

describe('LibrarySearchInteractions.handleButton — routing guards', () => {
  it('returns early for an unrelated customId', async () => {
    const { lsi, searchService } = build();
    const press = makeButton('crowns-page:first:caller1:target1:Playcount:1');

    await lsi.handleButton(press);

    expect(searchService.search).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('returns early when a page id has fewer than 5 parts', async () => {
    const { lsi, searchService } = build();
    const press = makeButton(`search:page:${nextKey()}:0`);

    await lsi.handleButton(press);

    expect(searchService.search).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('returns early when a tab id has fewer than 5 parts', async () => {
    const { lsi, searchService } = build();
    const press = makeButton(`search:tab:${nextKey()}:0`);

    await lsi.handleButton(press);

    expect(searchService.search).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('replies ephemerally when the page id omits the target user entirely', async () => {
    const { lsi, searchService } = build();
    const press = makeButton(`search:page:${nextKey()}:0:1`);

    await lsi.handleButton(press);

    expect(searchService.search).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Only the user who initiated the search can interact with these controls.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });
});

describe('LibrarySearchInteractions.handleButton — ownership', () => {
  it('replies ephemerally when another user presses the control', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const { lsi, searchService } = build();
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 2, 'someoneelse'));

    await lsi.handleButton(press);

    expect(searchService.search).not.toHaveBeenCalled();
    expect(builderSpy).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Only the user who initiated the search can interact with these controls.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('replies about expiry when the session has expired', async () => {
    const { lsi, searchService } = build();
    const press = makeButton(PAGE_ID(`${nextKey()}-gone`, SearchTab.Tracks, 1));

    await lsi.handleButton(press);

    expect(searchService.search).not.toHaveBeenCalled();
    expect(builderSpy).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('This search session has expired. Please run the command again.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('checks ownership before the cache', async () => {
    const { lsi } = build();
    const press = makeButton(PAGE_ID(`${nextKey()}-never-stored`, SearchTab.Tracks, 1, 'someoneelse'));

    await lsi.handleButton(press);

    const payload = press.reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toBe('Only the user who initiated the search can interact with these controls.');
  });
});

describe('LibrarySearchInteractions.handleButton — page navigation', () => {
  it('searches with the cached user, query and tab', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const { lsi, searchService } = build();
    const press = makeButton(PAGE_ID(key, SearchTab.Artists, 3));

    await lsi.handleButton(press);

    expect(searchService.search).toHaveBeenCalledWith(42, 'radiohead', SearchTab.Artists);
  });

  it('passes the parsed page number to the builder', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const { lsi } = build();
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 4));

    await lsi.handleButton(press);

    expect(builderSpy).toHaveBeenCalledTimes(1);
    expect(builderSpy.mock.calls[0]![0]).toMatchObject({ page: 4, tab: SearchTab.Tracks });
  });

  it('reads the target user from the sixth part for page ids', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const { lsi, colorService } = build();
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 1, 'target9'), { user: { id: 'target9' } });

    await lsi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('target9');
    expect(builderSpy.mock.calls[0]![0]).toMatchObject({ targetDiscordUserId: 'target9' });
  });

  it('updates the interaction with the built payload', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const { lsi } = build();
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 0));

    await lsi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledWith({ components: [] });
    expect(press.reply).not.toHaveBeenCalled();
  });
});

describe('LibrarySearchInteractions.handleButton — tab navigation', () => {
  it('forces page 0 for tab ids', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'creep', 7);
    const { lsi, searchService } = build();
    const press = makeButton(TAB_ID(key, SearchTab.Plays));

    await lsi.handleButton(press);

    expect(searchService.search).toHaveBeenCalledWith(7, 'creep', SearchTab.Plays);
    expect(builderSpy.mock.calls[0]![0]).toMatchObject({ page: 0, tab: SearchTab.Plays });
  });

  it('reads the target user from the fifth part for tab ids', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'creep', 7);
    const { lsi, colorService } = build();
    const press = makeButton(TAB_ID(key, SearchTab.Albums, 'target9'), { user: { id: 'target9' } });

    await lsi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('target9');
    expect(builderSpy.mock.calls[0]![0]).toMatchObject({ targetDiscordUserId: 'target9', page: 0 });
  });

  it('updates the interaction for a tab switch', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'creep', 7);
    const { lsi } = build();
    const press = makeButton(TAB_ID(key, SearchTab.Tracks));

    await lsi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
  });
});

describe('LibrarySearchInteractions.handleButton — builder arguments', () => {
  it('passes every search page option through', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const rows = makeRows(5);
    const { lsi } = build({
      searchService: { search: vi.fn(async () => rows) },
      colorService: { getAccentColorAsync: vi.fn(async () => 0x123456) },
    });
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 2));

    await lsi.handleButton(press);

    expect(builderSpy).toHaveBeenCalledTimes(1);
    expect(builderSpy).toHaveBeenCalledWith({
      query: 'radiohead',
      tab: SearchTab.Tracks,
      page: 2,
      allRows: rows,
      cacheKey: key,
      targetDiscordUserId: 'caller1',
      accentColor: 0x123456,
    });
  });

  it('forwards a null accent colour unchanged', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'radiohead', 42);
    const { lsi } = build({ colorService: { getAccentColorAsync: vi.fn(async () => null) } });
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 0));

    await lsi.handleButton(press);

    expect(builderSpy.mock.calls[0]![0]).toMatchObject({ accentColor: null });
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('passes an empty result set straight to the builder', async () => {
    const key = nextKey();
    storeSearchQuery(key, 'nothing', 42);
    const { lsi } = build({ searchService: { search: vi.fn(async () => []) } });
    const press = makeButton(PAGE_ID(key, SearchTab.Tracks, 0));

    await lsi.handleButton(press);

    expect(builderSpy.mock.calls[0]![0]).toMatchObject({ allRows: [] });
    expect(press.update).toHaveBeenCalledTimes(1);
  });
});
