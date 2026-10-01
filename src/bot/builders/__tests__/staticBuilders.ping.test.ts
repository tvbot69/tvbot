/**
 * `StaticBuilders.buildPingResponse` — the one card in the builders directory
 * that reports something the bot measured about ITSELF rather than about a user.
 *
 * It is here because it is the cheapest possible example of the rule the rest of
 * this directory is tested against: a number in a card has to be the number that
 * was read. A ping that renders `0ms` because the gateway gave us `undefined` is
 * the same lie as `.plays` rendering 0, and the type of `gatewayLatencyMs` is the
 * only thing standing between the two.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { StaticBuilders } from '@bot/builders/staticBuilders';

describe('StaticBuilders.buildPingResponse', () => {
  it('reports the latency it was handed', () => {
    expect(StaticBuilders.buildPingResponse(42).embed.data.description).toBe('Pong! Gateway latency: `42ms`');
  });

  it('formats a four-digit latency with a separator, matching every other number on the bot', () => {
    expect(StaticBuilders.buildPingResponse(1234).embed.data.description).toContain('`1,234ms`');
  });

  it('reports a genuinely zero latency as zero rather than hiding it', () => {
    // A measured zero is a real answer — a locally-reachable gateway really can
    // be under a millisecond. The dishonest direction is `undefined`, which is
    // the type's job, not this builder's.
    expect(StaticBuilders.buildPingResponse(0).embed.data.description).toBe('Pong! Gateway latency: `0ms`');
  });

  it('colours the card only when a colour was supplied', () => {
    expect(StaticBuilders.buildPingResponse(1).embed.toJSON().color).toBeUndefined();
    expect(StaticBuilders.buildPingResponse(1, 0x57f287).embed.toJSON().color).toBe(0x57f287);
  });

  it('produces a plain embed the dispatcher can send without a container', () => {
    const response = StaticBuilders.buildPingResponse(7);
    expect(response.isComponentsV2).toBe(false);
    expect(response.hasEmbed()).toBe(true);
    expect(response.buildComponents()).toEqual([]);
  });
});
