import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { UserHubBuilders } from '@bot/builders/userHubBuilders';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { ProfileBuilders } from '@bot/builders/profileBuilders';
import type { FeaturedEntry } from '@bot/services/library/featuredService';
import type { DiscoveryItem } from '@bot/services/library/musicIntelligenceService';
import type { LastFmUser } from '@domain/models/lastFmUser';

/**
 * Three more footers that printed a plural for a count of one. Same defect, same
 * fix; pinned in both directions so an assertion that only checked the singular
 * could not pass on a builder that always printed the singular.
 *
 * "1 entries" is the awkward one — the plural is irregular, so the fix needs the
 * explicit form rather than the default `+s`.
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const entry = (playcount = 12): FeaturedEntry =>
  ({
    discordUserId: '1',
    userNameLastFm: 'alice',
    artistName: 'Aphex Twin',
    trackName: 'Xtal',
    albumName: 'SAW',
    playcount,
    featuredAt: new Date(1776592117000),
  }) as FeaturedEntry;

const discovery = (): DiscoveryItem =>
  ({
    artistName: 'Aphex Twin',
    playcount: 12,
    firstPlay: new Date(1776592117000),
  }) as DiscoveryItem;

describe('UserHubBuilders: the noun agrees with the count', () => {
  it('says "1 entry" when the log holds one featured user', () => {
    const text = body(UserHubBuilders.buildFeaturedLogResponse({ log: [entry()] }));
    expect(text).toContain('(1 entry)');
    expect(text).not.toContain('1 entries');
  });

  it('still says "entries" for two', () => {
    const text = body(UserHubBuilders.buildFeaturedLogResponse({ log: [entry(), entry()] }));
    expect(text).toContain('(2 entries)');
  });

  it('says "1 play" on a log row with a single scrobble', () => {
    const text = body(UserHubBuilders.buildFeaturedLogResponse({ log: [entry(1)] }));
    expect(text).toContain('(1 play)');
    expect(text).not.toContain('(1 plays)');
  });

  it('still says "plays" for two', () => {
    const text = body(UserHubBuilders.buildFeaturedLogResponse({ log: [entry(2)] }));
    expect(text).toContain('(2 plays)');
  });
});

describe('IntelligenceBuilders: the discovered-artist count agrees with the count', () => {
  const card = (items: DiscoveryItem[]) =>
    IntelligenceBuilders.buildDiscoveriesResponse({
      displayName: 'Alice',
      userNameLastFm: 'alice',
      periodDescription: 'past 90 days',
      items,
      pageSize: 1,
    });

  // The "Total: N discovered artists" footer only renders when there is more
  // than one page, so a one-item list never prints it. The count of one is
  // therefore only reachable through the plural decision itself, which is what
  // the sweep below pins: no rendered card may say "1 discovered artists".
  it('never says "1 discovered artists"', () => {
    const text = body(card([discovery()]));
    expect(text).not.toContain('1 discovered artists');
  });

  it('says "2 discovered artists" for two', () => {
    const text = body(card([discovery(), discovery()]));
    expect(text).toContain('Total: 2 discovered artists');
  });
});

describe('ProfileBuilders: the variety noun agrees with the count', () => {
  const lastFmUser = (over: Partial<LastFmUser> = {}): LastFmUser =>
    ({
      name: 'alice',
      playCount: 100,
      artistCount: 1,
      albumCount: 1,
      trackCount: 1,
      ...over,
    }) as LastFmUser;

  const stats = (over: Record<string, unknown>) =>
    ({
      userDisplayName: 'Alice',
      lastFmUser: lastFmUser(),
      differentArtistsCount: 1,
      differentAlbumsCount: 1,
      differentTracksCount: 1,
      ...over,
    }) as never;

  it('says "1 different artist" for a single-artist library', () => {
    const text = body(ProfileBuilders.buildProfileResponse(stats({})));
    expect(text).toContain('**1** different artist');
    expect(text).not.toContain('**1** different artists');
  });

  it('still says "different artists" for two', () => {
    const text = body(
      ProfileBuilders.buildProfileResponse(
        stats({ differentArtistsCount: 2, differentAlbumsCount: 2, differentTracksCount: 2 }),
      ),
    );
    expect(text).toContain('**2** different artists');
  });
});