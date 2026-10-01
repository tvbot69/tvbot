import { describe, expect, it } from 'vitest';
import { pluralise } from '@bot/builders/common/pluralise';

describe('pluralise', () => {
  it('agrees with the count for the regular case', () => {
    expect(pluralise(1, 'artist')).toBe('artist');
    expect(pluralise(0, 'artist')).toBe('artists');
    expect(pluralise(2, 'artist')).toBe('artists');
    expect(pluralise(1309, 'play')).toBe('plays');
  });

  it('takes the irregular plural when one is given', () => {
    expect(pluralise(1, 'entry', 'entries')).toBe('entry');
    expect(pluralise(2, 'entry', 'entries')).toBe('entries');
    expect(pluralise(0, 'entry', 'entries')).toBe('entries');
  });

  it('defaults the plural to the singular plus s', () => {
    // Locked so a future default change cannot silently alter every call site.
    expect(pluralise(5, 'crown')).toBe('crowns');
  });

  it('never touches the count, so a caller keeps its own formatting', () => {
    // The call sites format the number themselves — some with toLocaleString(),
    // some not — so this returns the WORD only. If it ever started formatting the
    // number, every rendered card would change.
    expect(pluralise(1309, 'track')).toBe('tracks');
  });
});