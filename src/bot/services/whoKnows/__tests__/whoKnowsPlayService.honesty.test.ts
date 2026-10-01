import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsPlayService } from '../whoKnowsPlayService';
import type { CacheService } from '../../system/cacheService';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';

/**
 * `WhoKnowsPlayService` — the "Also playing: X and Y" footer line.
 *
 * This is the smallest service in the who-knows tree and it had no test file at
 * all, which is how a whole class of silent-failure shapes went unpinned.
 *
 * WHAT THE LINE CLAIMS, AND WHAT IT MUST NOT CLAIM
 * ----------------------------------------------
 * The footer asserts that OTHER people in THIS server are listening to this
 * thing RIGHT NOW. So:
 *
 *  - no matching listener is `null`, and `null` means the builder omits the line.
 *    It must never become `Also playing: ` with nothing after it, and it must
 *    never become "0 others".
 *  - the caller is skipped, because being told you are also playing something
 *    you are playing is not information.
 *  - the count of "others" is derived from the LIST, so three named people and
 *    "and 2 others" cannot disagree with each other.
 *
 * THE CACHE KEY IS THE WHOLE MECHANISM
 * ------------------------------------
 * There is no query. The answer is whatever `cache.get()` returns for a key this
 * class composes out of a userId, a fixed tag, and the lowercased entity name.
 * That makes the key shape load-bearing in a way a normal service is not: if the
 * tag or the case handling drifts, the line goes silently blank and NOBODY finds
 * out, because an absent line looks exactly like "nobody else is listening".
 * So every tag and every lowercasing is asserted here, and asserted against the
 * exact key the writer (`NowPlayingInteractions` / the scrobble path) uses.
 */

/** A guild-user row. Only `userNameLastFm` is read. */
const member = (userId: number, userNameLastFm = `lfm_${userId}`): FullGuildUserDetails => ({
  userId,
  discordUserId: `d-${userId}`,
  userNameLastFm,
  whoKnowsWhitelisted: null,
  whoKnowsBanned: false,
});

const guildUsers = (...users: FullGuildUserDetails[]): Map<number, FullGuildUserDetails> =>
  new Map(users.map((u) => [u.userId, u]));

/**
 * A cache double keyed exactly the way the service builds its keys.
 *
 * `get` is declared `async (..._args: unknown[]) => ...` rather than a bare
 * zero-arg `vi.fn`, per rule 2 of this brief: a zero-arg mock infers a `[]` call
 * tuple and `mock.calls[0][0]` is then a COMPILE error vitest never reports.
 */
const cacheOf = (present: ReadonlySet<string>) => {
  const get = vi.fn(async (..._args: unknown[]) => {
    const key = String(_args[0]);
    return present.has(key) ? { timePlayed: new Date(), nowPlaying: true } : undefined;
  });
  return { cache: { get } as unknown as CacheService, get };
};

const ARTIST = 'Radiohead';
const ALBUM = 'OK Computer';
const TRACK = 'Creep';

describe('WhoKnowsPlayService: nothing to say is null, not a sentence about nobody', () => {
  it('returns null for an empty guild, before it reads a single cache key', async () => {
    // The empty-guild short-circuit exists so a DM does not pay N cache reads to
    // discover there are no members. Asserting the call count pins the guard,
    // not just the return value.
    const { cache, get } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);

    await expect(service.getGuildAlsoPlayingArtist(1, guildUsers(), ARTIST)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('returns null when nobody else is listening, rather than "Also playing: nobody"', async () => {
    const { cache } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);

    await expect(
      service.getGuildAlsoPlayingArtist(1, guildUsers(member(2), member(3)), ARTIST),
    ).resolves.toBeNull();
  });

  it('returns null for all three entity types when there is no match', async () => {
    const { cache } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);
    const users = guildUsers(member(2), member(3));

    await expect(service.getGuildAlsoPlayingAlbum(1, users, ARTIST, ALBUM)).resolves.toBeNull();
    await expect(service.getGuildAlsoPlayingTrack(1, users, ARTIST, TRACK)).resolves.toBeNull();
  });

  it('treats a falsy cache value as nobody, because a cached false is not a listener', async () => {
    // Someone could write `false`, `0` or `''` into the cache. `if (play)` is the
    // guard that keeps that from rendering as a blank name.
    const get = vi.fn(async (..._args: unknown[]) => undefined);
    const service = new WhoKnowsPlayService({ get } as unknown as CacheService);

    await expect(
      service.getGuildAlsoPlayingArtist(1, guildUsers(member(2)), ARTIST),
    ).resolves.toBeNull();
  });
});

describe('WhoKnowsPlayService: the cache keys it reads', () => {
  it('uses a per-user artist key with the entity name lowercased', async () => {
    const { cache, get } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);

    await service.getGuildAlsoPlayingArtist(1, guildUsers(member(2)), 'RaDiOhEaD');

    expect(get.mock.calls.map((c) => c[0])).toEqual(['2-lp-artist-radiohead']);
  });

  it('uses a per-user album key carrying both names lowercased', async () => {
    const { cache, get } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);

    await service.getGuildAlsoPlayingAlbum(1, guildUsers(member(2)), 'Radiohead', 'OK Computer');

    expect(get.mock.calls.map((c) => c[0])).toEqual(['2-lp-album-radiohead-ok computer']);
  });

  it('uses a per-user track key carrying both names lowercased', async () => {
    const { cache, get } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);

    await service.getGuildAlsoPlayingTrack(1, guildUsers(member(2)), 'Radiohead', 'Creep');

    expect(get.mock.calls.map((c) => c[0])).toEqual(['2-lp-track-radiohead-creep']);
  });

  it('reads one key per guild member, so the fan-out is bounded by the guild size', async () => {
    const { cache, get } = cacheOf(new Set());
    const service = new WhoKnowsPlayService(cache);

    await service.getGuildAlsoPlayingArtist(1, guildUsers(member(2), member(3), member(4)), ARTIST);

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('never reads the caller\'s own key, because they are not "also playing"', async () => {
    // A caller who is playing this exact thing would otherwise be told they are
    // also playing it.
    const { cache, get } = cacheOf(new Set(['1-lp-artist-radiohead']));
    const service = new WhoKnowsPlayService(cache);

    await service.getGuildAlsoPlayingArtist(1, guildUsers(member(1), member(2)), ARTIST);

    expect(get.mock.calls.map((c) => c[0])).not.toContain('1-lp-artist-radiohead');
  });

  it('keeps the three key prefixes distinct, so an artist hit cannot satisfy an album query', async () => {
    // The tags are the only thing separating three different claims. If they
    // collided, "someone is playing this artist" would render as "someone is
    // playing this album", which is a different and false statement.
    const { cache } = cacheOf(new Set(['2-lp-artist-radiohead']));
    const service = new WhoKnowsPlayService(cache);
    const users = guildUsers(member(2));

    await expect(service.getGuildAlsoPlayingArtist(1, users, ARTIST)).resolves.toContain('Also playing');
    await expect(service.getGuildAlsoPlayingAlbum(1, users, ARTIST, ALBUM)).resolves.toBeNull();
    await expect(service.getGuildAlsoPlayingTrack(1, users, ARTIST, TRACK)).resolves.toBeNull();
  });
});

describe('WhoKnowsPlayService: how it renders one, two, three and many', () => {
  const playing = (...ids: number[]) => {
    const present = new Set(ids.map((id) => `${id}-lp-artist-radiohead`));
    return cacheOf(present);
  };

  it('names a single other listener, with no "and"', async () => {
    const { cache } = playing(2);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(1, guildUsers(member(2), member(3)), ARTIST);

    // One name, one link, and no trailing conjunction - the singular case is a
    // different sentence from the plural, not the plural with a word removed.
    expect(line).toBe('Also playing: **[lfm_2](https://www.last.fm/user/lfm_2)**');
    expect(line).not.toContain(' and ');
  });

  it('joins two with "and"', async () => {
    const { cache } = playing(2, 3);
    const service = new WhoKnowsPlayService(cache);

    expect(
      await service.getGuildAlsoPlayingArtist(1, guildUsers(member(2), member(3), member(4)), ARTIST),
    ).toBe(
      'Also playing: **[lfm_2](https://www.last.fm/user/lfm_2)** and **[lfm_3](https://www.last.fm/user/lfm_3)**',
    );
  });

  it('lists three in full with a serial comma', async () => {
    const { cache } = playing(2, 3, 4);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(
      1, guildUsers(member(2), member(3), member(4), member(5)), ARTIST,
    );

    expect(line).toContain('**, **');
    expect(line).toContain(' and ');
    expect(line).not.toContain('others');
  });

  it('counts the remainder rather than naming a fourth, fifth and sixth', async () => {
    // Two names plus a count. Rendering all of them would overflow the footer and
    // the COUNT is the part a reader can trust at a glance.
    const { cache } = playing(2, 3, 4, 5, 6);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(
      1, guildUsers(member(2), member(3), member(4), member(5), member(6), member(7)), ARTIST,
    );

    expect(line).toContain('and 3 others');
    expect(line).not.toContain('lfm_4');
    expect(line).not.toContain('lfm_5');
  });

  it('derives the "others" count from the list, so it cannot disagree with the names', async () => {
    // Four listeners means "and 2 others" - not "and 3 others". An off-by-one
    // here is a number about real people.
    const { cache } = playing(2, 3, 4, 5);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(
      1, guildUsers(member(2), member(3), member(4), member(5)), ARTIST,
    );

    expect(line).toContain('and 2 others');
  });

  it('links each name to that person\'s Last.fm profile', async () => {
    const { cache } = playing(2);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(
      1, guildUsers(member(2, 'Alice Example')), ARTIST,
    );

    expect(line).toContain('https://www.last.fm/user/Alice%20Example');
  });

  it('escapes a username with a space or an accent, so the link does not break', async () => {
    const { cache } = playing(2);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(
      1, guildUsers(member(2, 'Sigur Rós')), ARTIST,
    );

    expect(line).toContain('https://www.last.fm/user/Sigur%20R%C3%B3s');
  });

  it('renders the same way for an album and a track, because the sentence is the same', async () => {
    const albumCache = cacheOf(new Set(['2-lp-album-radiohead-ok computer']));
    const trackCache = cacheOf(new Set(['2-lp-track-radiohead-creep']));
    const users = guildUsers(member(2), member(3));

    const albumLine = await new WhoKnowsPlayService(albumCache.cache).getGuildAlsoPlayingAlbum(
      1, users, ARTIST, ALBUM,
    );
    const trackLine = await new WhoKnowsPlayService(trackCache.cache).getGuildAlsoPlayingTrack(
      1, users, ARTIST, TRACK,
    );

    expect(albumLine).toContain('Also playing');
    expect(trackLine).toBe(albumLine);
  });

  it('never mentions the caller among the others, even when they are in the guild', async () => {
    const { cache } = playing(2, 1);
    const service = new WhoKnowsPlayService(cache);

    const line = await service.getGuildAlsoPlayingArtist(1, guildUsers(member(1), member(2)), ARTIST);

    expect(line).not.toContain('lfm_1');
    expect(line).toContain('lfm_2');
  });
});