import { describe, it, expect } from 'vitest';
import { CrownBuilders } from './crownBuilders';
import type { UserCrownDto } from '@domain/models/crownModels';

/**
 * The crowns footer printed "N total crowns" whatever N was, so a listener with
 * exactly one crown read "1 total crowns". Both directions are pinned: an
 * assertion that only checked the singular would also pass on a builder that
 * always printed the singular.
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const crown = (artistName: string): UserCrownDto => ({
  crownId: 1,
  guildId: '123456789',
  userId: 10,
  artistName,
  currentPlaycount: 40,
  startPlaycount: 30,
  created: new Date(1776592117000),
  modified: new Date(1776592117000),
  active: true,
  seededCrown: false,
});

const card = (crowns: UserCrownDto[]) =>
  CrownBuilders.buildCrownsResponse('moha', '687636049576722472', '687636049576722472', crowns, 1, 'Playcount');

describe('CrownBuilders: the crown count agrees with the count', () => {
  it('says "1 total crown" for one crown', () => {
    const text = body(card([crown('TV Girl')]));
    expect(text).toContain('1 total crown');
    expect(text).not.toContain('1 total crowns');
  });

  it('still says "total crowns" for two', () => {
    const text = body(card([crown('TV Girl'), crown('d4vd')]));
    expect(text).toContain('2 total crowns');
  });
});
