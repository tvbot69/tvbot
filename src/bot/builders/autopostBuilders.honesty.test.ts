/**
 * `AutopostBuilders.buildAutopostOverview` — the `.autopost` list.
 *
 * This card is a claim about what the bot will POST on the guild's behalf, and
 * the honest cases are all about absence:
 *
 *  - no autoposts is a real, common state, and it gets a sentence plus the syntax
 *    rather than a "0 autoposts" row that looks like a failed read;
 *  - an autopost that has never fired says "Never" rather than a timestamp of
 *    the epoch, which is what a naive `new Date(null)` would render;
 *  - a paused autopost is visibly paused, because a paused post that reads as
 *    active is a promise the bot will not keep.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { AutopostBuilders } from './autopostBuilders';
import type { AutopostConfig } from '@bot/services/autopostService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
}

const json = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[]; accent_color?: number };

const texts = (response: ResponseModel): string[] =>
  json(response).components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content ?? '');

const body = (response: ResponseModel): string => texts(response).join('\n');

const autopost = (over: Partial<AutopostConfig> = {}): AutopostConfig => ({
  id: 'ap-1',
  guildId: 'g-1',
  channelId: 'c-1',
  schedule: 'Weekly',
  contentType: 'TopArtists',
  enabled: true,
  lastPosted: null,
  ...over,
});

const card = (autoposts: AutopostConfig[], prefix = '!') =>
  AutopostBuilders.buildAutopostOverview({ guildName: 'Music Club', autoposts, prefix });

describe('AutopostBuilders.buildAutopostOverview', () => {
  it('renders an empty state that reads as an empty state, with the syntax to fix it', () => {
    const text = body(card([]));
    expect(text).toContain('No autoposts are currently set up for this server.');
    expect(text).toContain('!autopost add <topartists|topalbums|toptracks|crowns> <daily|weekly|monthly> [#channel]');
    // No count, because a count of zero is indistinguishable from a failed read
    // and this query cannot fail — it either has rows or it does not.
    expect(text).not.toContain('0 autoposts');
  });

  it('names the server it is listing', () => {
    expect(texts(card([]))[0]).toContain('### ⏰ Scheduled Autoposts for **Music Club**');
  });

  it('renders an active autopost with its channel, schedule and enabled state', () => {
    const text = body(card([autopost()]));
    expect(text).toContain('**#ap-1 • Top Artists** (Weekly)');
    expect(text).toContain('> Channel: <#c-1>');
    expect(text).toContain('> Status: 🟢 Active • Last posted: Never');
  });

  it('renders a paused autopost as paused', () => {
    expect(body(card([autopost({ enabled: false })]))).toContain('> Status: ⏸️ Paused • Last posted: Never');
  });

  it('renders the last post as a relative timestamp when there was one', () => {
    const posted = new Date('2026-09-20T10:00:00Z');
    const text = body(card([autopost({ lastPosted: posted })]));
    expect(text).toContain(`Last posted: <t:${Math.floor(posted.getTime() / 1000)}:R>`);
    expect(text).not.toContain('Last posted: Never');
  });

  it('says "Never" for a null last post rather than rendering the epoch', () => {
    // `new Date(null)` is 1970-01-01, and a relative timestamp of "55 years ago"
    // would be a confident wrong answer about when the bot last posted.
    const text = body(card([autopost({ lastPosted: null })]));
    expect(text).toContain('Last posted: Never');
    expect(text).not.toContain(':R>');
  });

  it('spaces out the crowded content types and leaves ServerCrowns alone', () => {
    const text = body(
      card([
        autopost({ id: 'a', contentType: 'TopAlbums' }),
        autopost({ id: 'b', contentType: 'TopTracks' }),
        autopost({ id: 'c', contentType: 'ServerCrowns' }),
      ]),
    );
    expect(text).toContain('**#a • Top Albums**');
    expect(text).toContain('**#b • Top Tracks**');
    expect(text).toContain('**#c • ServerCrowns**');
  });

  it('separates the autoposts and still ends with the management help', () => {
    const text = body(card([autopost({ id: 'a' }), autopost({ id: 'b' })]));
    expect(text).toContain('> Status: 🟢 Active • Last posted: Never\n\n**#b');
    expect(text).toContain('-# Manage: `!autopost toggle <id>` • `!autopost remove <id>` • `!autopost send <id>`');
  });

  it('does not offer the management help on the empty card, which has nothing to manage', () => {
    expect(body(card([]))).not.toContain('autopost toggle');
  });

  it('uses the guild prefix in both the empty-state syntax and the management help', () => {
    const text = body(card([], '~'));
    expect(text).toContain('`~autopost add');
    const withRows = body(card([autopost()], '~'));
    expect(withRows).toContain('`~autopost toggle <id>`');
  });

  it('accents with the supplied colour, and falls back to the bot blue rather than to nothing', () => {
    const custom = AutopostBuilders.buildAutopostOverview({
      guildName: 'G',
      autoposts: [],
      prefix: '!',
      accentColor: 0x123456,
    });
    expect(json(custom).accent_color).toBe(0x123456);
    expect(json(card([])).accent_color).toBe(DiscordConstants.LastFmColorBlue);
  });

  it('treats a null accent as absent rather than as colour zero', () => {
    const response = AutopostBuilders.buildAutopostOverview({
      guildName: 'G',
      autoposts: [],
      prefix: '!',
      accentColor: null,
    });
    expect(json(response).accent_color).toBe(DiscordConstants.LastFmColorBlue);
  });

  it('always reports success, because the list itself is a complete answer', () => {
    expect(card([]).commandResponse).toBe(CommandResponse.Ok);
    expect(card([autopost()]).commandResponse).toBe(CommandResponse.Ok);
  });

  it('produces a valid container for a long list without dropping the last entry', () => {
    const many = Array.from({ length: 8 }, (_, i) => autopost({ id: `ap-${i}` }));
    const text = body(card(many));
    expect(json(card(many)).components.length).toBeGreaterThan(0);
    expect(text).toContain('**#ap-7');
  });
});
