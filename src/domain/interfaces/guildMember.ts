/**
 * Read a guild member's display name without casting the guild to `any`.
 *
 * Five interaction handlers were written as
 *
 *     (interaction.guild as any)?.members.cache.get(userId)?.displayName ?? fallback
 *
 * The cast is there because `interaction.guild` is a union across interaction
 * types, and the API-data arm of that union has no `members`. Casting to `any`
 * silenced a real narrowing problem rather than solving it, and it cost the type
 * checker on both sides of the expression.
 *
 * One narrow accessor, with the union handled once. Returns `undefined` when the
 * member is not cached, which is normal - cache misses happen, and the caller
 * already has a fallback.
 */

/** The shape we actually read, which is a subset of discord.js's GuildMember. */
interface MemberCache {
  members?: {
    cache?: {
      get(id: string): { displayName?: string; user?: { username?: string } } | undefined;
    };
  };
}

export const memberDisplayName = (guild: unknown, userId: string): string | undefined => {
  const member = (guild as MemberCache | null | undefined)?.members?.cache?.get(userId);
  return member?.displayName ?? member?.user?.username;
};
