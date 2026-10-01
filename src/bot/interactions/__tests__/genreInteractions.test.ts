import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  GenreInteractions,
  storeGenreQuery,
  getCachedGenreQuery,
} from '../genreInteractions';
import type { CachedGenreQuery } from '../genreInteractions';
import { GenreBuilders } from '@bot/builders/genreBuilders';
import type { TopGenreItem, WhoKnowsGenreItem } from '@bot/services/genreService';
import type { ButtonInteraction } from 'discord.js';

const makeGenres = (n: number): TopGenreItem[] =>
  Array.from({ length: n }, (_, i) => ({
    genreName: `genre ${i + 1}`,
    userPlaycount: 100 - i,
  }));

const makeArtists = (n: number): { artistName: string; userPlaycount: number }[] =>
  Array.from({ length: n }, (_, i) => ({ artistName: `Artist ${i + 1}`, userPlaycount: 50 - i }));

const makeWhoKnows = (n: number): WhoKnowsGenreItem[] =>
  Array.from({ length: n }, (_, i) => ({
    userId: i + 1,
    discordUserId: `discord${i + 1}`,
    userNameLastFm: `user${i + 1}`,
    playcount: 10 - i,
  }));

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const genreService = {
    getGuildArtistsForGenre: vi.fn(async () => makeArtists(3)),
    getUserArtistsForGenre: vi.fn(async () => makeArtists(2)),
    ...(over.genreService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'user1' })),
    ...(over.userService as object),
  };
  const gi = new GenreInteractions(genreService as never, userService as never);
  return { gi, genreService, userService };
};

const seed = (key: string, data: Partial<Omit<CachedGenreQuery, 'expiresAt'>> = {}): void => {
  storeGenreQuery(key, { type: 'info', ...data } as Omit<CachedGenreQuery, 'expiresAt'>);
};

/** Sentinel payload so assertions on `update` stay independent of builder internals. */
const sentinel = (label: string) => ({ toMessagePayload: () => ({ label }) });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(GenreBuilders, 'buildTopGenresResponse').mockReturnValue(sentinel('top') as never);
  vi.spyOn(GenreBuilders, 'buildGenreArtistsResponse').mockReturnValue(sentinel('artists') as never);
  vi.spyOn(GenreBuilders, 'buildWhoKnowsGenreResponse').mockReturnValue(sentinel('whoknows') as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storeGenreQuery / getCachedGenreQuery', () => {
  it('round-trips a stored query', async () => {
    seed('rt-1', { genreName: 'shoegaze', displayName: 'moha' });

    const cached = await getCachedGenreQuery('rt-1');

    expect(cached?.genreName).toBe('shoegaze');
    expect(cached?.displayName).toBe('moha');
  });

  it('stamps a future expiresAt on store', async () => {
    const before = Date.now();
    seed('rt-2', { genreName: 'ambient' });

    const cached = await getCachedGenreQuery('rt-2');

    expect(cached!.expiresAt).toBeGreaterThanOrEqual(before);
  });

  it('returns undefined for an unknown key', async () => {
    await expect(getCachedGenreQuery('never-seeded-key')).resolves.toBeUndefined();
  });
});

describe('GenreInteractions.handleButton — routing guards', () => {
  it('ignores a customId that does not start with "genre:"', async () => {
    const { gi } = build();

    await gi.handleButton(mkButton('crowns-page:next:caller1:target1:Playcount:1'));

    expect(GenreBuilders.buildTopGenresResponse).not.toHaveBeenCalled();
    expect(GenreBuilders.buildGenreArtistsResponse).not.toHaveBeenCalled();
    expect(GenreBuilders.buildWhoKnowsGenreResponse).not.toHaveBeenCalled();
  });

  it('does nothing for a "genre:" id whose verb is neither toggle nor page', async () => {
    const { gi } = build();
    const press = mkButton('genre:mystery:arg:arg');

    await gi.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('GenreInteractions.handleButton — toggle ownership', () => {
  it('refuses a toggle from a different caller and never reads the store', async () => {
    const { gi, genreService } = build();
    seed('tog-1', { genreName: 'jazz', userId: 1 });
    const press = mkButton('genre:toggle:user:tog-1:0:someoneElse');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Only the user who initiated the command can interact with these controls.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
    expect(genreService.getUserArtistsForGenre).not.toHaveBeenCalled();
  });

  it('allows a toggle from the original caller', async () => {
    const { gi } = build();
    seed('tog-2', { genreName: 'jazz', userId: 7 });

    await gi.handleButton(mkButton('genre:toggle:user:tog-2:0:caller1'));

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledTimes(1);
  });
});

describe('GenreInteractions.handleButton — toggle expiry', () => {
  it('replies "expired" when nothing is cached', async () => {
    const { gi } = build();
    const press = mkButton('genre:toggle:user:missing-key:0:caller1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
  });

  it('replies "expired" when the cached entry has no genreName', async () => {
    const { gi } = build();
    seed('tog-3', { type: 'top', genres: makeGenres(3) });
    const press = mkButton('genre:toggle:user:tog-3:0:caller1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(GenreBuilders.buildGenreArtistsResponse).not.toHaveBeenCalled();
  });
});

describe('GenreInteractions.handleButton — toggle view switching', () => {
  it('reads guild artists for the server view', async () => {
    const { gi, genreService } = build();
    seed('tog-4', { genreName: 'metal', guildId: 'g1', serverName: 'TestGuild', userId: 7 });
    const press = mkButton('genre:toggle:server:tog-4:0:caller1');

    await gi.handleButton(press);

    expect(genreService.getGuildArtistsForGenre).toHaveBeenCalledWith('g1', 'metal');
    expect(genreService.getUserArtistsForGenre).not.toHaveBeenCalled();
    expect(press.update).toHaveBeenCalledWith({ label: 'artists' });
    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ isServerView: true, targetName: 'TestGuild', pageIndex: 0, pageSize: 10 }),
    );
  });

  it('reads user artists for the user view', async () => {
    const { gi, genreService } = build();
    seed('tog-5', { genreName: 'metal', guildId: 'g1', serverName: 'TestGuild', userId: 7 });
    const press = mkButton('genre:toggle:user:tog-5:0:caller1');

    await gi.handleButton(press);

    expect(genreService.getUserArtistsForGenre).toHaveBeenCalledWith(7, 'metal');
    expect(genreService.getGuildArtistsForGenre).not.toHaveBeenCalled();
    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ isServerView: false, targetName: 'User' }),
    );
  });

  it('falls back to user artists when the server view has no guildId', async () => {
    const { gi, genreService } = build();
    seed('tog-6', { genreName: 'metal', serverName: 'TestGuild', userId: 7 });
    const press = mkButton('genre:toggle:server:tog-6:0:caller1');

    await gi.handleButton(press);

    expect(genreService.getUserArtistsForGenre).toHaveBeenCalledWith(7, 'metal');
    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ isServerView: true, artists: makeArtists(2) }),
    );
  });

  it('builds with an empty artist list when neither guildId nor userId is cached', async () => {
    const { gi, genreService } = build();
    seed('tog-7', { genreName: 'metal' });
    const press = mkButton('genre:toggle:server:tog-7:0:caller1');

    await gi.handleButton(press);

    expect(genreService.getGuildArtistsForGenre).not.toHaveBeenCalled();
    expect(genreService.getUserArtistsForGenre).not.toHaveBeenCalled();
    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ artists: [], targetName: 'Server' }),
    );
    expect(press.update).toHaveBeenCalledWith({ label: 'artists' });
  });

  it('persists the flipped view and artists back onto the cached entry', async () => {
    const { gi } = build();
    seed('tog-8', { genreName: 'metal', guildId: 'g1', serverName: 'TestGuild', userId: 7 });

    await gi.handleButton(mkButton('genre:toggle:server:tog-8:0:caller1'));

    const cached = await getCachedGenreQuery('tog-8');
    expect(cached!.isServerView).toBe(true);
    expect(cached!.artists).toEqual(makeArtists(3));
  });

  it('resets to page 0 regardless of the page encoded in the customId', async () => {
    const { gi } = build();
    seed('tog-9', { genreName: 'metal', userId: 7 });

    await gi.handleButton(mkButton('genre:toggle:user:tog-9:4:caller1'));

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0, pageSize: 10 }),
    );
  });

  it('passes the cacheKey, caller and guildId through to the builder', async () => {
    const { gi } = build();
    seed('tog-10', { genreName: 'metal', guildId: 'g1', serverName: 'TestGuild', accentColor: 0x123456 });

    await gi.handleButton(mkButton('genre:toggle:server:tog-10:0:caller1'));

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        genreName: 'metal',
        cacheKey: 'tog-10',
        callerDiscordUserId: 'caller1',
        guildId: 'g1',
        accentColor: 0x123456,
      }),
    );
  });
});

describe('GenreInteractions.handleButton — page guards', () => {
  it('refuses a page from a different caller', async () => {
    const { gi } = build();
    seed('pg-1', { type: 'top', genres: makeGenres(25) });
    const press = mkButton('genre:page:next:top:pg-1:0:someoneElse');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Only the user who initiated the command can interact with these controls.',
      flags: MessageFlags.Ephemeral,
    });
    expect(GenreBuilders.buildTopGenresResponse).not.toHaveBeenCalled();
  });

  it('replies "expired" when nothing is cached', async () => {
    const { gi } = build();
    const press = mkButton('genre:page:next:top:missing-key:0:caller1');

    await gi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
  });

  it('builds nothing and updates nothing for an unknown interaction type', async () => {
    const { gi } = build();
    seed('pg-2', { type: 'top', genres: makeGenres(25) });
    const press = mkButton('genre:page:next:bogus:pg-2:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildTopGenresResponse).not.toHaveBeenCalled();
    expect(GenreBuilders.buildGenreArtistsResponse).not.toHaveBeenCalled();
    expect(GenreBuilders.buildWhoKnowsGenreResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });
});

describe('GenreInteractions.handleButton — page type "top"', () => {
  it('uses a page size of 10 and passes the cached genres', async () => {
    const { gi } = build();
    seed('pg-top-1', {
      type: 'top',
      genres: makeGenres(25),
      displayName: 'moha',
      periodDescription: 'last week',
      accentColor: 0xff0000,
    });
    const press = mkButton('genre:page:next:top:pg-top-1:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith({
      displayName: 'moha',
      genres: makeGenres(25),
      periodDescription: 'last week',
      pageIndex: 1,
      pageSize: 10,
      cacheKey: 'pg-top-1',
      callerDiscordUserId: 'caller1',
      accentColor: 0xff0000,
    });
    expect(press.update).toHaveBeenCalledWith({ label: 'top' });
  });

  it('defaults displayName, periodDescription and genres when absent', async () => {
    const { gi } = build();
    seed('pg-top-2', { type: 'top' });
    const press = mkButton('genre:page:first:top:pg-top-2:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'User',
        periodDescription: 'all time',
        genres: [],
        pageIndex: 0,
      }),
    );
  });

  it('navigates first to page 0', async () => {
    const { gi } = build();
    seed('pg-top-3', { type: 'top', genres: makeGenres(25) });

    await gi.handleButton(mkButton('genre:page:first:top:pg-top-3:2:caller1'));

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0 }),
    );
  });

  it('navigates prev without going below page 0', async () => {
    const { gi } = build();
    seed('pg-top-4', { type: 'top', genres: makeGenres(25) });

    await gi.handleButton(mkButton('genre:page:prev:top:pg-top-4:0:caller1'));

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0 }),
    );
  });

  it('navigates last to the final page', async () => {
    const { gi } = build();
    seed('pg-top-5', { type: 'top', genres: makeGenres(25) });

    await gi.handleButton(mkButton('genre:page:last:top:pg-top-5:0:caller1'));

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2 }),
    );
  });

  it('clamps next to the last page', async () => {
    const { gi } = build();
    seed('pg-top-6', { type: 'top', genres: makeGenres(12) });

    await gi.handleButton(mkButton('genre:page:next:top:pg-top-6:1:caller1'));

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 1 }),
    );
  });

  it('keeps the current page for an unrecognised action', async () => {
    const { gi } = build();
    seed('pg-top-7', { type: 'top', genres: makeGenres(25) });
    const press = mkButton('genre:page:sideways:top:pg-top-7:2:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2 }),
    );
    expect(press.update).toHaveBeenCalledWith({ label: 'top' });
  });

  it('treats a single-item list as one page and clamps a next off the end', async () => {
    const { gi } = build();
    seed('pg-top-8', { type: 'top', genres: makeGenres(1) });

    await gi.handleButton(mkButton('genre:page:next:top:pg-top-8:0:caller1'));

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0 }),
    );
  });
});

describe('GenreInteractions.handleButton — page type "info"', () => {
  it('uses a page size of 10 and the cached artists', async () => {
    const { gi } = build();
    seed('pg-info-1', {
      type: 'info',
      genreName: 'shoegaze',
      artists: makeArtists(25),
      displayName: 'moha',
      guildId: 'g1',
      accentColor: 0x00ff00,
    });
    const press = mkButton('genre:page:next:info:pg-info-1:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith({
      genreName: 'shoegaze',
      artists: makeArtists(25),
      isServerView: false,
      targetName: 'moha',
      pageIndex: 1,
      pageSize: 10,
      cacheKey: 'pg-info-1',
      callerDiscordUserId: 'caller1',
      accentColor: 0x00ff00,
      guildId: 'g1',
    });
    expect(press.update).toHaveBeenCalledWith({ label: 'artists' });
  });

  it('defaults genreName, artists and isServerView when absent', async () => {
    const { gi } = build();
    seed('pg-info-2', { type: 'info' });
    const press = mkButton('genre:page:first:info:pg-info-2:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        genreName: 'Genre',
        artists: [],
        isServerView: false,
        targetName: 'User',
        guildId: undefined,
      }),
    );
  });

  it('preserves a cached server view and names the server', async () => {
    const { gi } = build();
    seed('pg-info-3', {
      type: 'info',
      genreName: 'shoegaze',
      artists: makeArtists(25),
      isServerView: true,
      serverName: 'TestGuild',
      guildId: 'g1',
    });

    await gi.handleButton(mkButton('genre:page:prev:info:pg-info-3:1:caller1'));

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ isServerView: true, targetName: 'TestGuild', pageIndex: 0 }),
    );
  });

  it('falls back to "Server" when a server view has no serverName', async () => {
    const { gi } = build();
    seed('pg-info-4', { type: 'info', genreName: 'shoegaze', isServerView: true });

    await gi.handleButton(mkButton('genre:page:first:info:pg-info-4:0:caller1'));

    expect(GenreBuilders.buildGenreArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ targetName: 'Server' }),
    );
  });
});

describe('GenreInteractions.handleButton — page type "whoknows"', () => {
  it('uses a page size of 12 and the cached who-knows items', async () => {
    const { gi } = build();
    seed('pg-wk-1', {
      type: 'whoknows',
      genreName: 'jazz',
      serverName: 'TestGuild',
      whoknowsItems: makeWhoKnows(25),
      accentColor: 0xabcdef,
    });
    const press = mkButton('genre:page:next:whoknows:pg-wk-1:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildWhoKnowsGenreResponse).toHaveBeenCalledWith({
      genreName: 'jazz',
      serverName: 'TestGuild',
      items: makeWhoKnows(25),
      pageIndex: 1,
      pageSize: 12,
      cacheKey: 'pg-wk-1',
      callerDiscordUserId: 'caller1',
      accentColor: 0xabcdef,
    });
    expect(press.update).toHaveBeenCalledWith({ label: 'whoknows' });
  });

  it('defaults genreName, serverName and items when absent', async () => {
    const { gi } = build();
    seed('pg-wk-2', { type: 'whoknows' });
    const press = mkButton('genre:page:first:whoknows:pg-wk-2:0:caller1');

    await gi.handleButton(press);

    expect(GenreBuilders.buildWhoKnowsGenreResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        genreName: 'Genre',
        serverName: 'Server',
        items: [],
        pageIndex: 0,
        pageSize: 12,
      }),
    );
  });

  it('navigates last to the final who-knows page', async () => {
    const { gi } = build();
    seed('pg-wk-3', { type: 'whoknows', genreName: 'jazz', whoknowsItems: makeWhoKnows(25) });

    await gi.handleButton(mkButton('genre:page:last:whoknows:pg-wk-3:0:caller1'));

    expect(GenreBuilders.buildWhoKnowsGenreResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2 }),
    );
  });

  it('never calls the other two builders', async () => {
    const { gi } = build();
    seed('pg-wk-4', { type: 'whoknows', genreName: 'jazz', whoknowsItems: makeWhoKnows(25) });

    await gi.handleButton(mkButton('genre:page:next:whoknows:pg-wk-4:0:caller1'));

    expect(GenreBuilders.buildTopGenresResponse).not.toHaveBeenCalled();
    expect(GenreBuilders.buildGenreArtistsResponse).not.toHaveBeenCalled();
  });
});

describe('GenreInteractions.handleButton — real builders', () => {
  it('produces a Components V2 update payload from the real top-genres builder', async () => {
    vi.restoreAllMocks();
    const { gi } = build();
    seed('real-1', {
      type: 'top',
      genres: makeGenres(25),
      displayName: 'moha',
      periodDescription: 'all time',
    });
    const press = mkButton('genre:page:next:top:real-1:0:caller1');

    await gi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    const payload = press.update.mock.calls[0]![0] as { flags: number; components: unknown[] };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toHaveLength(1);
  });

  it('produces a Components V2 update payload from the real who-knows builder', async () => {
    vi.restoreAllMocks();
    const { gi } = build();
    seed('real-2', {
      type: 'whoknows',
      genreName: 'jazz',
      serverName: 'TestGuild',
      whoknowsItems: makeWhoKnows(25),
    });
    const press = mkButton('genre:page:last:whoknows:real-2:0:caller1');

    await gi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    const payload = press.update.mock.calls[0]![0] as { flags: number };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
  });
});
