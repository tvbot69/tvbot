import { describe, expect, it } from 'vitest';
import { MusicHistoryRepository } from '../musicHistoryRepository';
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
 * The eviction is LRU on WRITE, and that is the subtle part: `Map.set` on a key
 * that is already present does NOT move it to the end, so a guild the bot plays
 * in every day used to stay at the front of the insertion order and be the first
 * thing evicted, while a guild that joined a minute ago was kept. The cache lost
 * its hottest entries first. `addHistory` now deletes before re-setting, so the
 * order tracks the last play. Pinned below as current behaviour.
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

  it('evicts the COLDEST guild when the cap is exceeded', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < GUILD_CAP; n += 1) repo.addHistory(`g${n}`, track(n));

    repo.addHistory('overflow', track(9999));

    // One guild was dropped, and it was the one written longest ago. Without
    // the eviction, this entry is retained for the life of the process.
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

  it('evicts the LEAST RECENTLY PLAYED guild, not the longest-tracked one', () => {
    // The more surprising of the two orders used to be live. `Map.set` on an
    // existing key keeps its original position, so 'veteran' - first inserted,
    // then played again - sat at the front of the order and went first, while
    // the guild that had just arrived survived. The cache lost its hottest
    // entry every time it was asked to make room.
    const repo = new MusicHistoryRepository();
    repo.addHistory('veteran', track(1));
    for (let n = 0; n < GUILD_CAP - 1; n += 1) repo.addHistory(`g${n}`, track(n));

    // The veteran plays again, right before the cap is hit.
    repo.addHistory('veteran', track(2));
    repo.addHistory('overflow', track(3));

    // 'g0' is now the coldest guild: written once, never again. The veteran
    // played a moment ago, so it is the one that has to go next.
    expect(repo.getHistory('g0', 10)).toEqual([]);
    expect(repo.getHistory('veteran', 10)).toHaveLength(2);
    expect(repo.getHistory('overflow', 10)).toHaveLength(1);
  });

  it('a guild that plays stays, however long ago it first appeared', () => {
    // The bounding property, stated directly: one more play is worth more than
    // however many new servers joined since. Without the delete-before-set, a
    // busy guild's own history is what the cap threw away.
    const repo = new MusicHistoryRepository();
    repo.addHistory('veteran', track(1));
    for (let n = 0; n < GUILD_CAP - 1; n += 1) repo.addHistory(`g${n}`, track(n));

    for (let n = 0; n < 25; n += 1) repo.addHistory('veteran', track(n));
    for (let n = 0; n < 25; n += 1) repo.addHistory(`new-${n}`, track(n));

    // 25 newcomers pushed 25 of the never-replayed guilds out — g0 through g24,
    // oldest write first — and the veteran was never among them.
    expect(repo.getHistory('veteran', 60)).toHaveLength(26);
    expect(repo.getHistory('g0', 10)).toEqual([]);
    expect(repo.getHistory('g24', 10)).toEqual([]);
    expect(repo.getHistory('g25', 10)).toHaveLength(1);
  });

  it('evicts one guild per new guild, not a batch', () => {
    const repo = new MusicHistoryRepository();
    for (let n = 0; n < GUILD_CAP; n += 1) repo.addHistory(`g${n}`, track(n));

    repo.addHistory('over-1', track(1));
    repo.addHistory('over-2', track(2));

    // A cap that evicted everything over the limit on each insert would empty
    // the map; a cap that evicted nothing would grow it. One in, one out — and
    // because `size` is back at the cap after the first insert, the SECOND
    // overflow evicts again. Two guilds in means two out: `g0` then `g1`, each
    // the coldest at the time it was evicted.
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
