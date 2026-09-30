import { describe, expect, it } from 'vitest';
import { MusicHistoryRepository } from './musicHistoryRepository';
import type { MusicTrack } from '@domain/models/music/musicTrack';

/**
 * The 2000-guild eviction cap in `MusicHistoryRepository.addHistory`.
 *
 * `autopostRepository.claimIsAuthoritative.test.ts` already covers the 50-entry
 * per-guild cap, the newest-first ordering and the limit. What it does NOT
 * cover is the OTHER bound - the number of guilds - which exists because
 * `clearHistory()` was deleted as unreachable and nothing was left to evict a
 * guild's entry. Without the cap, one entry (up to 50 full track objects) is
 * retained for every guild the bot has EVER played in, for the life of the
 * process. That is a slow leak, which is the easiest kind to ship and the
 * hardest to notice.
 *
 * The eviction is FIFO on INSERTION order, and that is the subtle part: a Map
 * re-`set` on an existing key does not move it to the end. So a guild the bot
 * plays in every day stays at the front of the insertion order and is the
 * first thing evicted, while a guild that joined a minute ago is kept. Pinned
 * below as current behaviour.
 *
 * This is a pure in-memory class with no Prisma dependency, so it is the one
 * repository in the directory that can be tested for real rather than over a
 * double - 2000 real insertions and real assertions on what survived.
 */

const track = (n: number): MusicTrack =>
  ({
    identifier: `id${n}`,
    title: `t${n}`,
    author: `a${n}`,
    uri: '',
    duration: 1,
    isSeekable: true,
    isStream: false,
    artworkUrl: null,
    album: null,
    source: 'spotify',
    requester: 'u',
  }) as unknown as MusicTrack;

const GUILD_CAP = 2000;

describe('MusicHistoryRepository.addHistory guild cap', () => {
  it('tracks every guild up to the cap, and none is evicted', () => {
    const repo = new MusicHistoryRepository();

    for (let n = 0; n < GUILD_CAP; n += 1) repo.addHistory(`g${n}`, track(n));

    // The first guild is still there, so the cap is "at least 2000" and not
    // "off by one", which is the kind of boundary a `<` vs `<=` slip produces.
    expect(repo.getHistory('g0', 10)).toHaveLength(1);
    expect(repo.getHistory(`g${GUILD_CAP - 1}`, 10)).toHaveLength(1);
  });

  it('evicts the OLDEST-INSERTED guild when the cap is exceeded', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < GUILD_CAP; n += 1) repo.addHistory(`g${n}`, track(n));

    repo.addHistory('overflow', track(9999));

    // One guild was dropped, and it was the first one inserted. Without the
    // eviction, this entry is retained for the life of the process.
    expect(repo.getHistory('g0', 10)).toEqual([]);
    expect(repo.getHistory('overflow', 10)).toHaveLength(1);
    expect(repo.getHistory(`g${GUILD_CAP - 1}`, 10)).toHaveLength(1);
  });

  it('holds the total at the cap however many guilds arrive', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < GUILD_CAP + 500; n += 1) repo.addHistory(`g${n}`, track(n));

    let alive = 0;
    for (let n = 0; n < GUILD_CAP + 500; n += 1) {
      if (repo.getHistory(`g${n}`, 1).length > 0) alive += 1;
    }
    // The bounding assertion. A cap that evicts nothing grows without limit; a
    // cap that evicts the wrong entry loses live history.
    expect(alive).toBe(GUILD_CAP);
  });

  it('evicts in insertion order, not least-recently-USED order', () => {
    // DOCUMENTED BEHAVIOUR, and the more surprising of the two. `Map.set` on
    // an existing key keeps its original position, so a guild the bot plays in
    // every day is still sitting at the front of the order and is the next
    // eviction - while a guild that arrived a moment ago survives. The result
    // is a cache that loses its hottest entries first.
    const repo = new MusicHistoryRepository();
    repo.addHistory('veteran', track(1));
    for (let n = 0; n < GUILD_CAP - 1; n += 1) repo.addHistory(`g${n}`, track(n));

    // The veteran plays again, right before the cap is hit.
    repo.addHistory('veteran', track(2));
    repo.addHistory('overflow', track(3));

    // 'veteran' was the first key inserted, so it is the one that went.
    expect(repo.getHistory('veteran', 10)).toEqual([]);
    expect(repo.getHistory('overflow', 10)).toHaveLength(1);
  });

  it('evicts one guild per new guild, not a batch', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < GUILD_CAP; n += 1) repo.addHistory(`g${n}`, track(n));

    repo.addHistory('over-1', track(1));
    repo.addHistory('over-2', track(2));

    // A cap that evicted everything over the limit on each insert would empty
    // the map; a cap that evicted nothing would grow it. One in, one out — and
    // because `size` is back at the cap after the first insert, the SECOND
    // overflow evicts again. Two guilds in means two out: `g0` then `g1`, both
    // from the front of the insertion order.
    expect(repo.getHistory('g0', 10)).toEqual([]);
    expect(repo.getHistory('g1', 10)).toEqual([]);
    expect(repo.getHistory('over-1', 10)).toHaveLength(1);
    expect(repo.getHistory('over-2', 10)).toHaveLength(1);
    // And the third-oldest is the next one out, so the order really is FIFO
    // rather than "the first two happened to collide".
    expect(repo.getHistory('g2', 10)).toHaveLength(1);
  });

  it('does NOT evict when a guild it already tracks plays again', () => {
    const repo = new MusicHistoryRepository();
    // 'veteran' plus 1999 more is exactly the cap, so this addHistory is the
    // first one that could possibly evict anything.
    repo.addHistory('veteran', track(1));
    for (let n = 0; n < GUILD_CAP - 1; n += 1) repo.addHistory(`g${n}`, track(n));

    repo.addHistory('veteran', track(2));

    // The map is exactly at the cap and the re-add is not a new guild, so
    // nothing may be dropped. Evicting here would make a busy guild lose its
    // own history every time a new server is added.
    expect(repo.getHistory('veteran', 10)).toHaveLength(2);
    expect(repo.getHistory(`g${GUILD_CAP - 2}`, 10)).toHaveLength(1);
  });
});

describe('MusicHistoryRepository.getHistory', () => {
  it('returns an honest empty for a guild it has never seen', () => {
    const repo = new MusicHistoryRepository();
    expect(repo.getHistory('never-seen')).toEqual([]);
  });

  it('DEFAULT limit is ten, so an unbounded read cannot dump 50 entries', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < 20; n += 1) repo.addHistory('g1', track(n));

    // The cap allows 50, so a default of 10 is a deliberate UI bound and not
    // the storage cap leaking out.
    expect(repo.getHistory('g1')).toHaveLength(10);
  });

  it('honours a limit of zero', () => {
    const repo = new MusicHistoryRepository();
    repo.addHistory('g1', track(1));
    expect(repo.getHistory('g1', 0)).toEqual([]);
  });

  it('clamps nothing: a limit larger than the history returns the whole list', () => {
    const repo = new MusicHistoryRepository();
    repo.addHistory('g1', track(1));
    repo.addHistory('g1', track(2));
    expect(repo.getHistory('g1', 1000)).toHaveLength(2);
  });

  it('stamps a playedAt Date on every entry', () => {
    const repo = new MusicHistoryRepository();
    repo.addHistory('g1', track(1));

    const [item] = repo.getHistory('g1', 1);
    expect(item?.playedAt).toBeInstanceOf(Date);
    expect(item?.guildId).toBe('g1');
  });

  it('keeps guilds SEPARATE, so one server history never leaks into another', () => {
    const repo = new MusicHistoryRepository();
    repo.addHistory('g1', track(1));
    repo.addHistory('g2', track(2));

    expect(repo.getHistory('g1', 10).map((i) => i.track.title)).toEqual(['t1']);
    expect(repo.getHistory('g2', 10).map((i) => i.track.title)).toEqual(['t2']);
  });

  it('returns a COPY, so a caller cannot corrupt the store by mutating the result', () => {
    // `slice` returns a copy of the array, so `historyByGuild` still holds a
    // reference to the real one and `addHistory` keeps unshifting onto it.
    const repo = new MusicHistoryRepository();
    repo.addHistory('g1', track(1));

    const first = repo.getHistory('g1', 10);
    first.length = 0;
    repo.addHistory('g1', track(2));

    expect(repo.getHistory('g1', 10).map((i) => i.track.title)).toEqual(['t2', 't1']);
  });
});
