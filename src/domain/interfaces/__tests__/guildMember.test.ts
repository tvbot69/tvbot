import { describe, it, expect } from 'vitest';
import { memberDisplayName } from '../guildMember';

describe('memberDisplayName', () => {
  const member = (displayName?: string, username?: string) => ({ displayName, user: { username } });
  const guildOf = (m: unknown) => ({ members: { cache: { get: () => m } } });

  it('prefers the per-guild display name', () => {
    expect(memberDisplayName(guildOf(member('Bob', 'bob_lfm')), 'u1')).toBe('Bob');
  });

  it('falls back to the account username', () => {
    expect(memberDisplayName(guildOf(member(undefined, 'bob_lfm')), 'u1')).toBe('bob_lfm');
  });

  it('returns undefined on a cache miss, so the caller keeps its fallback', () => {
    expect(memberDisplayName(guildOf(undefined), 'u1')).toBeUndefined();
  });

  it('survives a null guild', () => {
    // `interaction.guild` is nullable on every interaction type.
    expect(memberDisplayName(null, 'u1')).toBeUndefined();
  });

  it('survives the API-data arm of the guild union, which has no members', () => {
    // The case that made the original `as any` necessary.
    expect(memberDisplayName({ id: '1', name: 'g' }, 'u1')).toBeUndefined();
  });

  it('survives a guild with no member cache at all', () => {
    expect(memberDisplayName({ members: {} }, 'u1')).toBeUndefined();
    expect(memberDisplayName({}, 'u1')).toBeUndefined();
  });
});
