import { describe, it, expect } from 'vitest';
import { GuildAdminBuilders } from './guildAdminBuilders';
import type { GuildMemberOverviewItem } from '@bot/services/guildAdminService';

/**
 * Two defects on the members card, both the same shape: a claim the data does
 * not support, or an unsendable card.
 *
 *  1. "N crowns" on a row printed the plural for one crown.
 *  2. `pageSize: 0` sliced to nothing, `lines.join('\n')` was `''`, and
 *     `TextDisplayBuilder.setContent('')` threw — the card could not be sent.
 *     A `page` past the last page did the same.
 *
 * The "Total: N members" footer is deliberately NOT asserted for a single
 * member: it only renders when there is more than one page, so a one-member
 * server never prints it and the count can never be one.
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const member = (over: Partial<GuildMemberOverviewItem> = {}): GuildMemberOverviewItem =>
  ({
    discordUserId: '1',
    userNameLastFm: 'alice',
    displayName: 'Alice',
    totalPlayCount: 100,
    crownsCount: 0,
    whoKnowsBanned: false,
    ...over,
  }) as GuildMemberOverviewItem;

const members = (count: number) => Array.from({ length: count }, (_, i) => member({ discordUserId: String(i) }));

describe('GuildAdminBuilders: the noun agrees with the count', () => {
  it('says "1 crown" on a row holding one crown', () => {
    const text = body(
      GuildAdminBuilders.buildMembersOverviewResponse({
        guildName: 'G',
        members: [member({ crownsCount: 1 })],
      }),
    );
    expect(text).toContain('**1** crown');
    expect(text).not.toContain('**1** crowns');
  });

  it('still says "crowns" for two', () => {
    const text = body(
      GuildAdminBuilders.buildMembersOverviewResponse({
        guildName: 'G',
        members: [member({ crownsCount: 2 })],
      }),
    );
    expect(text).toContain('**2** crowns');
  });
});

describe('GuildAdminBuilders: an unreadable page size must not cost the card', () => {
  it('renders the members list when pageSize is 0 instead of throwing', () => {
    const response = GuildAdminBuilders.buildMembersOverviewResponse({
      guildName: 'G',
      members: members(3),
      pageSize: 0,
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).toContain('alice');
  });

  it('renders a page for a page index past the end instead of throwing', () => {
    // `page` is clamped at the low end but not against `totalPages`, so the
    // slice came back empty and `setContent('')` rejected it.
    const response = GuildAdminBuilders.buildMembersOverviewResponse({
      guildName: 'G',
      members: members(3),
      page: 9999,
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
  });
});
