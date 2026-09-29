import type { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { Guild } from '@persistence/domain/models/guild';

/**
 * What we know about one listener's DISCORD ROLES, as a tri-state.
 *
 * The old shape was `roles?: string[]`, and `undefined` was doing two
 * incompatible jobs at once: "this member is not in the guild" and "we could
 * not ask". `CrownService` read it as `u.roles ?? []`, so a member-fetch failure
 * silently dropped a real listener from crown contention in any guild with
 * `.crownroles` configured - and `replaceCrown` then wrote a crown naming the
 * person below them. The list of roles was never read, and the row that
 * resulted is a permanent, named claim about two people.
 *
 *   - `read: true`  - we have the member and this is their role id list. An
 *                     EMPTY array is a real answer (a member who holds no
 *                     role we care about), not an absence of an answer.
 *   - `read: false, absent: true`  - Discord answered, and the answer was "that
 *                     user is not in this guild" (error code 10007, checked by
 *                     `isUnknownDiscordMember`). A real absence. They hold no
 *                     guild role, so a crownRoles guild legitimately excludes
 *                     them.
 *   - `read: false, absent: false` - we asked and could not find out (a 5xx, a
 *                     403, 50001 Missing Access, 130000 overloaded, a socket
 *                     error). NOT an absence. Anything that turns this into
 *                     "no roles" is a fabricated claim.
 *
 * `undefined` on the field means the role question was never posed for this row
 * at all - no `discordGuild` (a DM), or no linked Discord account on the
 * `guild_user` row. That is treated as `unknown` by {@link crownRoleVerdict},
 * which is the conservative direction: no crown write names a person on a
 * question that was never asked.
 */
export type WhoKnowsRoleRead =
  | { readonly read: true; readonly roles: string[] }
  | { readonly read: false; readonly absent: boolean };

/**
 * `eligible` / `ineligible` / `unknown`, for the `crownRoles` gate.
 *
 * Kept as one named function in the model rather than inlined into
 * `CrownService`, so the "no roles" / "roles unknown" distinction is stated
 * once and both the service and its tests read the same rule. Only
 * `'unknown'` may stop a crown write.
 */
export type CrownRoleVerdict = 'eligible' | 'ineligible' | 'unknown';

export const crownRoleVerdict = (
  roles: WhoKnowsRoleRead | undefined,
  required: ReadonlySet<string>,
): CrownRoleVerdict => {
  if (roles === undefined) return 'unknown';
  if (!roles.read) return roles.absent ? 'ineligible' : 'unknown';
  return roles.roles.some((r) => required.has(r)) ? 'eligible' : 'ineligible';
};

export interface WhoKnowsUser {
  userId: number;
  playcount: number;
  plays?: number;
  userName?: string;
  lastFmUsername: string;
  discordName?: string;
  discordUserId?: string;
  registeredLastFm?: Date;
  privacyLevel?: PrivacyLevel;
  lastUsed?: Date;
  lastMessage?: Date;
  sameServer?: boolean;
  hasCrown?: boolean;
  /** See {@link WhoKnowsRoleRead}. Never a bare `string[]`. */
  roles?: WhoKnowsRoleRead;
}

export interface FilterStats {
  startCount: number;
  endCount: number;
  activityThresholdFiltered?: number;
  blockedFiltered?: number;
  requesterFiltered?: boolean;
  /** Privacy opt-outs removed silently (never rendered — the count itself leaks). */
  privacyFiltered?: number;
}

export interface WhoKnowsArtistContext {
  guild: Guild | null;
  guildUsers: Map<number, FullGuildUserDetails>;
  filteredUsersWithArtist: WhoKnowsUser[];
  filterStats: FilterStats;
  genres?: string[];
  crownModel?: import('@domain/models/crownModels').CrownModel | null;
}

export interface WhoKnowsSettings {
  newSearchValue: string;
  responseMode: WhoKnowsMode;
  qualityFilterDisabled: boolean;
  redirectsEnabled: boolean;
}
