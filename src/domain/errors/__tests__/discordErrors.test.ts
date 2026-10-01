import { describe, expect, it } from 'vitest';
import {
  discordRetryAfterMs,
  errorMessage,
  isDiscordRateLimit,
  isTerminalDiscordError,
  isUnknownInteraction,
  isUnrecoverableMessageFetch,
} from '@domain/errors/discordErrors';

/**
 * Fixtures mirror the shapes discord.js actually produces, because the whole
 * point of this module is that the input is `unknown` and the shape has to be
 * probed. A fixture invented to match the helper proves nothing - these are
 * the three documented error shapes:
 *
 *  - DiscordAPIError     : { code, message, status } and, for a REST JSON
 *                          error, `rawError` holding the response body.
 *  - HTTPError / rate    : `retryAfter` in MILLISECONDS, set by @discordjs/rest
 *                          when it pre-emptively sleeps.
 *  - a plain thrown value: `throw 'string'` and `throw { code: 1 }` are legal
 *                          JavaScript, which is why the input is unknown.
 */

describe('discordRetryAfterMs', () => {
  it('reads retryAfter as milliseconds, unscaled', () => {
    // @discordjs/rest already converts to ms. Multiplying here would be a bug.
    expect(discordRetryAfterMs({ retryAfter: 2500 })).toBe(2500);
  });

  it('reads rawError.retry_after as SECONDS and scales it', () => {
    // The trap. 0.35s is returned by the API and must become 350ms.
    expect(discordRetryAfterMs({ rawError: { retry_after: 0.35 } })).toBe(350);
  });

  it('reads a bare top-level retry_after as seconds', () => {
    expect(discordRetryAfterMs({ retry_after: 2 })).toBe(2000);
  });

  it('prefers retryAfter over rawError when both are present', () => {
    expect(discordRetryAfterMs({ retryAfter: 100, rawError: { retry_after: 5 } })).toBe(100);
  });

  it('ignores zero, negative and non-numeric hints', () => {
    // 0 would otherwise be a falsy-but-valid "no wait", which reads as
    // "unknown" and gets replaced by a hardcoded 60s elsewhere.
    expect(discordRetryAfterMs({ rawError: { retry_after: 0 } })).toBe(0);
    expect(discordRetryAfterMs({ retryAfter: -5 })).toBe(0);
    expect(discordRetryAfterMs({ retryAfter: Number.NaN })).toBe(0);
    expect(discordRetryAfterMs({ rawError: { retry_after: 'soon' } })).toBe(0);
  });

  it('returns 0 for values that are not error-shaped at all', () => {
    expect(discordRetryAfterMs(null)).toBe(0);
    expect(discordRetryAfterMs(undefined)).toBe(0);
    expect(discordRetryAfterMs('rate limited')).toBe(0);
    expect(discordRetryAfterMs(42)).toBe(0);
  });
});

describe('isDiscordRateLimit', () => {
  it('detects a 429 by status', () => {
    expect(isDiscordRateLimit({ status: 429 })).toBe(true);
  });

  it('detects a rate limit that only carried a retry hint', () => {
    // The status can be missing when @discordjs/rest pre-emptively throttles
    // locally and throws before it ever sees the response.
    expect(isDiscordRateLimit({ retryAfter: 1200 })).toBe(true);
  });

  it('does not treat a 500 as a rate limit', () => {
    expect(isDiscordRateLimit({ status: 500, message: 'Internal Server Error' })).toBe(false);
  });
});

describe('isTerminalDiscordError', () => {
  it('treats 10008 (Unknown Message) as terminal', () => {
    // The message is gone; nothing a retry does can bring it back.
    expect(isTerminalDiscordError({ code: 10008, message: 'Unknown Message' })).toBe(true);
  });

  it('treats a 404 as terminal', () => {
    expect(isTerminalDiscordError({ status: 404 })).toBe(true);
  });

  it('does NOT treat 50013 (Missing Permissions) as terminal', () => {
    // Regression-locked. The card publisher runs a bounded retry so one
    // permission hiccup cannot lose a chapter attach, and 50013 is precisely
    // the case that retry exists for. An earlier draft of this helper lumped
    // 50013 in with 10008 and silently deleted that retry; this assertion is
    // what caught it.
    expect(isTerminalDiscordError({ code: 50013 })).toBe(false);
  });

  it('does not treat a 429 or a 500 as terminal', () => {
    // A 429 is NOT terminal: waiting and retrying is exactly the right move,
    // and forgetting the cached message here would drop a live card.
    expect(isTerminalDiscordError({ status: 429 })).toBe(false);
    expect(isTerminalDiscordError({ status: 500 })).toBe(false);
    expect(isTerminalDiscordError(null)).toBe(false);
  });
});

describe('isUnknownInteraction', () => {
  it('detects 10062 by code', () => {
    expect(isUnknownInteraction({ code: 10062, message: 'Unknown interaction' })).toBe(true);
  });

  it('detects it from the message when no code is present', () => {
    // The second path exists because some failures reach us as a plain Error
    // whose text names the problem. These call sites were string-matching
    // before, so dropping it would have re-introduced ERROR-level noise.
    expect(isUnknownInteraction(new Error('Unknown interaction'))).toBe(true);
  });

  it('does not fire on an unrelated handler failure', () => {
    expect(isUnknownInteraction(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isUnknownInteraction({ code: 10008 })).toBe(false);
    expect(isUnknownInteraction(null)).toBe(false);
  });
});

describe('isUnrecoverableMessageFetch', () => {
  it('treats a missing-permission FETCH as unrecoverable', () => {
    // The deliberate difference from isTerminalDiscordError: we cannot SEE the
    // message, so there is no retry target, unlike an edit we already hold.
    expect(isUnrecoverableMessageFetch({ code: 50013 })).toBe(true);
  });

  it('treats a deleted message as unrecoverable', () => {
    expect(isUnrecoverableMessageFetch({ code: 10008 })).toBe(true);
    expect(isUnrecoverableMessageFetch({ status: 404 })).toBe(true);
  });

  it('leaves a rate limit or server error recoverable', () => {
    // Both are worth retrying: 429 means back off, 5xx means try again.
    expect(isUnrecoverableMessageFetch({ status: 429 })).toBe(false);
    expect(isUnrecoverableMessageFetch({ status: 500 })).toBe(false);
    expect(isUnrecoverableMessageFetch(null)).toBe(false);
  });
});

describe('errorMessage', () => {
  it('returns an Error message unchanged', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a thrown string unchanged', () => {
    expect(errorMessage('plain string throw')).toBe('plain string throw');
  });

  it('prefers rawError.message over a useless "Unknown Error"', () => {
    // This is the real shape: discord.js sets message to "Unknown Error" for
    // RESTJSONErrors and puts the description in the body.
    const err = {
      code: 50035,
      message: 'Unknown Error',
      status: 400,
      rawError: { message: 'Invalid Form Body', code: 50035 },
    };
    expect(errorMessage(err)).toBe('Invalid Form Body');
  });

  it('serialises rawError when it carries no message field', () => {
    const err = { status: 400, rawError: { code: 50035, errors: { 'activity.name': ['Missing'] } } };
    expect(errorMessage(err)).toContain('50035');
  });

  it('does not produce [object Object] for a thrown plain object', () => {
    // The reason this helper exists. `String(err)` on this input returns
    // "[object Object]", which tells you nothing when reading a log.
    const err = { reason: 'queue full', retryAfter: 30 };
    expect(errorMessage(err)).toContain('queue full');
    expect(errorMessage(err)).not.toBe('[object Object]');
  });

  it('survives a circular thrown value instead of throwing', () => {
    const err: Record<string, unknown> = { name: 'loop' };
    err.self = err;
    expect(() => errorMessage(err)).not.toThrow();
  });

  it('survives a getter that throws', () => {
    const err = {
      get message(): string {
        throw new Error('exploding getter');
      },
    };
    // Must not propagate: this is called from catch blocks, and a throw here
    // would replace the original failure with an unrelated one.
    expect(() => errorMessage(err)).not.toThrow();
  });

  it('truncates a very long message', () => {
    const long = 'x'.repeat(900);
    const out = errorMessage(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders null and undefined rather than throwing', () => {
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
