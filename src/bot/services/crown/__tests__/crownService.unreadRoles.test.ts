/**
 * `CrownService.getAndUpdateCrownForArtist` and the `crownRoles` gate, and the
 * site the last round's hand-off flagged as needing more than one file.
 *
 * The bug: `WhoKnowsUser.roles` was `string[] | undefined`, and `undefined` was
 * doing two incompatible jobs. In a guild that has configured `.crownroles`,
 * the eligibility filter read it as `u.roles ?? []`, so a member whose roles
 * could not be read was indistinguishable from a member who holds none of the
 * required roles - and was dropped from contention. `replaceCrown` then wrote
 * the crown naming the person below them. The row is a permanent claim about
 * two named people, produced from a role list that was never fetched.
 *
 * `WhoKnowsRoleRead` splits the two apart, and this file is the proof that only
 * the "could not ask" half stops a write. Every test below uses the SAME two
 * listeners, the SAME playcounts, and the SAME guild, and varies only the
 * leader's role state - so the pair cannot both be satisfied by a version that
 * treats the states identically, which is exactly the version that was broken.
 *
 *   unknown (Discord unreachable) -> nothing is written, the standing crown is
 *                                   returned unchanged
 *   absent  (member left, 10007)  -> the leader is excluded and the person
 *                                   below is crowned, exactly as before
 *
 * Doubles are fresh plain objects per test. Nothing here is spied on, so there
 * is no `mockRestore` hazard.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CrownService } from '@bot/services/crown/crownService';
import type { WhoKnowsRoleRead, WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { CrownRepository } from '@persistence/repositories/crownRepository';
import type { UserService } from '@bot/services/user/userService';
import type { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';

const GUILD_ID = '1445761601129943222';
const CROWN_ROLE = '555';

/** `crownRoles` set: the only configuration in which roles are consulted at all. */
const ROLE_GUILD = { guildId: GUILD_ID, crownRoles: [CROWN_ROLE] } as never;

/** Roles were read and the member holds the required one. */
const HOLDS_CROWN_ROLE: WhoKnowsRoleRead = { read: true, roles: [CROWN_ROLE] };
/** Roles were read and the member holds none of them. A real, negative answer. */
const HOLDS_OTHER_ROLES: WhoKnowsRoleRead = { read: true, roles: ['999'] };
/** Discord answered "not in this guild" (10007). A real absence. */
const NOT_A_MEMBER: WhoKnowsRoleRead = { read: false, absent: true };
/** We asked Discord and it did not answer. NOT an absence. */
const COULD_NOT_ASK: WhoKnowsRoleRead = { read: false, absent: false };

/** The listener who leads, and the one directly below. The whole bug is between them. */
// `undefined` is a legal value for the field: `crownRoleVerdict` treats it as
// `unknown`, which is the third state the tri-state exists for — a row the
// question was never posed about. So the helpers take it.
const leader = (roles: WhoKnowsRoleRead | undefined): WhoKnowsUser => ({
  userId: 1, playcount: 200, lastFmUsername: 'leader', discordName: 'Leader', roles,
});
const runnerUp = (roles: WhoKnowsRoleRead | undefined): WhoKnowsUser => ({
  userId: 2, playcount: 150, lastFmUsername: 'runner', discordName: 'Runner', roles,
});

const standingCrown = (userId: number) => ({
  crownId: 5,
  guildId: GUILD_ID,
  userId,
  artistName: 'Mond',
  currentPlaycount: userId === 1 ? 200 : 150,
  startPlaycount: 100,
  created: new Date(),
  modified: new Date(),
  active: true,
  seededCrown: false,
  userNameLastFm: userId === 1 ? 'leader' : 'runner',
  discordUserId: userId === 1 ? '111' : '222',
});

/**
 * Constructor arity, read off `crownService.ts`:
 * (crownRepository, userService, lastfmRepository?, errorRateTracker?,
 *  abuseFilter?).
 *
 * `lastfmRepository` is `undefined` on purpose: `getHolderLivePlaycount` returns
 * null immediately, which fails the steal open, so the live Last.fm recheck is
 * not a second site under test here. The fifth argument is `undefined` rather
 * than `{}` because the eligibility filter calls
 * `this.abuseFilter?.isFlagged(...)`, which optional-chains the filter but not
 * the method - a bare `{}` throws a TypeError from inside the filter and
 * masks the behaviour. `isElevated` is false so the global-outage kill switch
 * does not stand in for the thing under test.
 */
const build = (currentCrown: ReturnType<typeof standingCrown> | null) => {
  const createCrown = vi.fn(async (data: Record<string, unknown>) => ({
    ...standingCrown(2),
    ...data,
    crownId: 9,
  }));
  const replaceCrown = vi.fn(async () => null);
  const updateCrownPlaycount = vi.fn(async () => undefined);
  const getCurrentCrown = vi.fn(async () => currentCrown);
  const crownRepository = {
    getCurrentCrown,
    createCrown,
    replaceCrown,
    updateCrownPlaycount,
  } as unknown as CrownRepository;

  const service = new CrownService(
    crownRepository,
    {} as unknown as UserService,
    undefined,
    { isElevated: vi.fn(() => false) } as unknown as LastfmErrorRateTracker,
    undefined,
  );
  return { service, createCrown, replaceCrown, updateCrownPlaycount, getCurrentCrown };
};

describe('CrownService crownRoles gate: unread roles must not name a holder', () => {
  it('writes no crown when the leader\u2019s roles could not be read', async () => {
    // The failure half. The leader outranks the runner-up by 50 plays, so the
    // broken version dropped the leader and created a crown naming the
    // runner-up. The load-bearing assertion is on the WRITE, not on the return
    // value: a version that wrote and then re-threw would satisfy a
    // return-shape assertion.
    const { service, createCrown, replaceCrown, updateCrownPlaycount } = build(standingCrown(1));

    const res = await service.getAndUpdateCrownForArtist(
      [leader(COULD_NOT_ASK), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      ROLE_GUILD,
      'Mond',
    );

    expect(createCrown).not.toHaveBeenCalled();
    expect(replaceCrown).not.toHaveBeenCalled();
    expect(updateCrownPlaycount).not.toHaveBeenCalled();
    // And the standing crown is re-read and returned untouched, so the card
    // still shows a crown that WAS verified rather than losing it entirely.
    expect(res?.crown.userId).toBe(1);
    // No announcement either way: nothing was claimed and nothing was stolen.
    expect(res?.crownResult).toBeUndefined();
  });

  it('writes no crown and invents none when the leader\u2019s roles are unread and no crown exists yet', async () => {
    // The claim half, which is the sharper one: with an empty crown store the
    // broken version CREATED a crown naming the runner-up out of a role list it
    // never read. A brand-new, permanent, named claim.
    const { service, createCrown, replaceCrown } = build(null);

    const res = await service.getAndUpdateCrownForArtist(
      [leader(COULD_NOT_ASK), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      ROLE_GUILD,
      'Mond',
    );

    expect(createCrown).not.toHaveBeenCalled();
    expect(replaceCrown).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('blocks the write for a listener with no role state at all', async () => {
    // `roles === undefined` is the third state: the question was never posed for
    // this row (no linked Discord account, so there was never a member to ask
    // about). It is not evidence of ineligibility, so it must block too.
    const { service, createCrown } = build(null);

    await service.getAndUpdateCrownForArtist(
      [leader(undefined), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      ROLE_GUILD,
      'Mond',
    );

    expect(createCrown).not.toHaveBeenCalled();
  });

  it('still crowns the person below when the leader genuinely left the server', async () => {
    // The failure half's PAIR, and the test that makes the first one mean
    // something. Discord answered 10007 for the leader, so the leader really
    // does hold no guild role, the exclusion is justified, and the runner-up
    // taking the crown is the correct outcome. If the fix had simply "blocks on
    // any unread role state", this would fail - and it must not, because that
    // would freeze crowns in every guild where anyone ever leaves.
    const { service, createCrown } = build(null);

    const res = await service.getAndUpdateCrownForArtist(
      [leader(NOT_A_MEMBER), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      ROLE_GUILD,
      'Mond',
    );

    expect(createCrown).toHaveBeenCalledTimes(1);
    // `createCrown` is given `currentPlaycount`/`startPlaycount`, not the
    // who-knows `playcount` - naming the wrong key would have made this a
    // vacuous assertion.
    expect(createCrown.mock.calls[0]![0]).toMatchObject({ userId: 2, currentPlaycount: 150 });
    expect(res?.claimed).toBe(true);
  });

  it('still excludes a member whose roles were read and match nothing', async () => {
    // The `read: true, roles: []`-shaped case. A read that found no required
    // role is a real NEGATIVE answer and must keep behaving as one - the fix
    // must not have turned "read, no match" into "unknown".
    const { service, createCrown } = build(null);

    await service.getAndUpdateCrownForArtist(
      [leader(HOLDS_OTHER_ROLES), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      ROLE_GUILD,
      'Mond',
    );

    expect(createCrown).toHaveBeenCalledTimes(1);
    expect(createCrown.mock.calls[0]![0]).toMatchObject({ userId: 2 });
  });

  it('does not consult roles at all in a guild that configures none', async () => {
    // The regression this fix could most easily have caused. Without this, a
    // gate that fired unconditionally would freeze crowns in EVERY guild during
    // any Discord hiccup, which is a far worse outage than the one being fixed.
    const { service, createCrown } = build(null);

    const res = await service.getAndUpdateCrownForArtist(
      [leader(COULD_NOT_ASK), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      { guildId: GUILD_ID, crownRoles: [] } as never,
      'Mond',
    );

    expect(createCrown).toHaveBeenCalledTimes(1);
    expect(createCrown.mock.calls[0]![0]).toMatchObject({ userId: 1, currentPlaycount: 200 });
    expect(res?.claimed).toBe(true);
  });

  it('re-reads the standing crown before giving up, rather than returning null', async () => {
    // Proves the blocked path returns the crown it re-read instead of quietly
    // blanking the marker, so a green "no wrong crown" cannot come from the
    // card simply losing its crown.
    const { service, getCurrentCrown } = build(standingCrown(1));

    const res = await service.getAndUpdateCrownForArtist(
      [leader(COULD_NOT_ASK), runnerUp(HOLDS_CROWN_ROLE)],
      new Map(),
      ROLE_GUILD,
      'Mond',
    );

    expect(getCurrentCrown).toHaveBeenCalled();
    expect(res?.crown.userId).toBe(1);
  });
});
