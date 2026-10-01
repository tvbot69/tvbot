import { describe, it, expect } from 'vitest';
import { GenreBuilders } from '@bot/builders/genreBuilders';

/**
 * Three footers on the genre cards printed the plural unconditionally, so a
 * genre with one top artist read "1 artists" and a genre with one listener read
 * "1 listeners". A count is a claim; the noun has to agree with it.
 *
 * Both directions are pinned: asserting only the singular would also pass on a
 * builder that always printed the singular.
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const genre = (name: string, playcount = 10, topArtists: string[] = []) => ({
  genreName: name,
  userPlaycount: playcount,
  globalPlaycount: playcount * 10,
  listeners: 2,
  topArtists,
});

const topGenres = (genres: ReturnType<typeof genre>[]) =>
GenreBuilders.buildTopGenresResponse({
    displayName: 'Alice',
    genres,
    periodDescription: 'weekly',
    pageIndex: 0,
    cacheKey: 'k',
    callerDiscordUserId: '1',
  });

describe('GenreBuilders: the noun agrees with the count', () => {
  it('says "1 total genre" for one genre', () => {
    const text = body(topGenres([genre('Shoegaze')]));
    expect(text).toContain('1 total genre');
    expect(text).not.toContain('1 total genres');
  });

  it('still says "total genres" for two', () => {
    const text = body(topGenres([genre('Shoegaze'), genre('Dream Pop')]));
    expect(text).toContain('2 total genres');
  });

  it('says "1 artist" in the genre-artists footer', () => {
    const text = body(
      GenreBuilders.buildGenreArtistsResponse({
        genreName: 'shoegaze',
        artists: [{ artistName: 'Nirvana', userPlaycount: 8 }],
        isServerView: false,
        targetName: 'Alice',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('1 artist ·');
    expect(text).not.toContain('1 artists ·');
  });

  it('still says "artists" in the genre-artists footer for two', () => {
    const text = body(
      GenreBuilders.buildGenreArtistsResponse({
        genreName: 'shoegaze',
        artists: [{ artistName: 'Nirvana', userPlaycount: 8 }, { artistName: 'Pixies', userPlaycount: 3 }],
        isServerView: false,
        targetName: 'Alice',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('2 artists ·');
  });

  it('says "1 listener" in the who-knows footer', () => {
    const text = body(
      GenreBuilders.buildWhoKnowsGenreResponse({
        genreName: 'shoegaze',
        serverName: 'Test Guild',
        items: [
          { userId: 1, userNameLastFm: 'alice', playcount: 12, discordUserId: '1' },
        ],
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('-# 1 listener ·');
    expect(text).not.toContain('1 listeners');
  });

  it('still says "listeners" for two', () => {
    const text = body(
      GenreBuilders.buildWhoKnowsGenreResponse({
        genreName: 'shoegaze',
        serverName: 'Test Guild',
        items: [
          { userId: 1, userNameLastFm: 'alice', playcount: 12, discordUserId: '1' },
          { userId: 2, userNameLastFm: 'bob', playcount: 4, discordUserId: '2' },
        ],
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('-# 2 listeners ·');
  });
});

describe('GenreBuilders: an unreadable page size must not cost the card', () => {
  it('renders the genres list when pageSize is 0 instead of throwing', () => {
    // `Math.ceil(n / 0)` is Infinity, the slice came back empty, `lines.join()`
    // was `''`, and `setContent('')` threw — the genres card became unsendable.
    const response = GenreBuilders.buildTopGenresResponse({
      displayName: 'Alice',
      genres: [genre('Shoegaze')],
      periodDescription: 'weekly',
      pageIndex: 0,
      pageSize: 0,
      cacheKey: 'k',
      callerDiscordUserId: '1',
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('Shoegaze');
  });

  it('renders the genre-artists list when pageSize is 0 instead of throwing', () => {
    const response = GenreBuilders.buildGenreArtistsResponse({
      genreName: 'shoegaze',
      artists: [{ artistName: 'Nirvana', userPlaycount: 8 }],
      isServerView: false,
      targetName: 'Alice',
      pageIndex: 0,
      pageSize: 0,
      cacheKey: 'k',
      callerDiscordUserId: '1',
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('Nirvana');
  });

  it('renders the who-knows list when pageSize is 0 instead of throwing', () => {
    const response = GenreBuilders.buildWhoKnowsGenreResponse({
      genreName: 'shoegaze',
      serverName: 'Test Guild',
      items: [
        { userId: 1, userNameLastFm: 'alice', playcount: 12, discordUserId: '1' },
      ],
      pageIndex: 0,
      pageSize: 0,
      cacheKey: 'k',
      callerDiscordUserId: '1',
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('alice');
  });
});