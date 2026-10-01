import { describe, it, expect, vi } from 'vitest';
import { replyChannel, typingChannel, fetchableChannel } from '@domain/interfaces/discord/discordChannel';

describe('discordChannel narrowing', () => {
  it('passes a real-ish channel straight through', () => {
    const ch = { send: vi.fn(async () => ({})) };
    expect(replyChannel(ch)).toBe(ch);
  });

  it('throws rather than returning null when send is missing', () => {
    // Every caller is on a path where replying IS the function, so a channel
    // that cannot receive a message is a bug worth surfacing.
    expect(() => replyChannel({})).toThrow(TypeError);
    expect(() => replyChannel(null)).toThrow(TypeError);
    expect(() => replyChannel(undefined)).toThrow(TypeError);
  });

  it('rejects a non-function send', () => {
    expect(() => replyChannel({ send: 'nope' })).toThrow(TypeError);
  });

  it('typingChannel requires sendTyping', () => {
    const ok = { send: async () => ({}), sendTyping: async () => {} };
    expect(typingChannel(ok)).toBe(ok);
    expect(() => typingChannel({ send: async () => ({}) })).toThrow(TypeError);
  });

  it('fetchableChannel requires messages', () => {
    const ok = { send: async () => ({}), messages: { fetch: async () => ({}) } };
    expect(fetchableChannel(ok)).toBe(ok);
    expect(() => fetchableChannel({ send: async () => ({}) })).toThrow(TypeError);
  });
});
