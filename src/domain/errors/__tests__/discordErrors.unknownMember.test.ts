/**
 * `isUnknownDiscordMember` - the predicate the crown path uses to tell a real
 * "that user is not in this guild" from every other way a member fetch can fail.
 *
 * The whole crown-role fix hangs off one question: which failures are an
 * ANSWER, and which are a failure to get one? Getting it backwards is the bug
 * this round exists to close - a misread "I could not ask" as "they are not
 * here" hands the crown to the wrong person, permanently.
 *
 * So the numbers here are not decoration. Each one is asserted against a REAL
 * `DiscordAPIError`, constructed the way `@discordjs/rest` constructs it, rather
 * than a duck-typed `{ code: 10007 }` literal. A literal would pass no matter
 * what the library does, and the whole reason this predicate can read a number
 * at all is that `DiscordAPIError` carries the body's `code` on the object -
 * `code: number | string`, `status: number` in `@discordjs/rest`'s own
 * typings.
 *
 * Codes verified against Discord's "JSON Error Codes" table
 * (https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes),
 * which is also where the neighbours below come from. Two of the numbers the
 * original hand-off note guessed are wrong, and both are load-bearing:
 *
 *   - 50014 is "Invalid authentication token provided". Missing Access is
 *     **50001**. A bot whose token is wrong is not a member who left.
 *   - 50013 is "You lack permissions to perform that action", which is a
 *     configuration fact, not an absence.
 *
 * No production code is mutated here - this is a predicate, so the interesting
 * half of its proof is the failures, which is what most of these cases are.
 */
import { describe, it, expect } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import { isUnknownDiscordMember } from '@domain/errors/discordErrors';

const url = 'https://discord.com/api/v10/guilds/1445761601129943222/members/222';

/**
 * The shape `@discordjs/rest` builds from a REST error body:
 * `new DiscordAPIError(body, body.code, status, method, url, requestBody)`.
 * `requestBody` is always the parsed request, never the response - the response
 * is `rawError`.
 */
const apiError = (code: number, status: number, message: string): DiscordAPIError =>
  new DiscordAPIError({ code, message }, code, status, 'GET', url, { files: undefined });

describe('isUnknownDiscordMember', () => {
  it('is true only for 10007 Unknown Member, the answer a left-the-server member gets', () => {
    // `GET /guilds/{guild.id}/members/{user.id}` answers HTTP 404 with this
    // body for a user who is not in the guild. This is the ONE case that is a
    // real absence: such a member holds no guild role, so a crownRoles guild
    // may legitimately exclude them and crown the person below.
    expect(isUnknownDiscordMember(apiError(10007, 404, 'Unknown Member'))).toBe(true);
  });

  it('is false for 50001 Missing Access - the neighbour the old note got wrong', () => {
    // 50014 is "Invalid authentication token provided"; Missing Access is
    // 50001. Either way this is a bot that cannot see, not a user who left.
    expect(isUnknownDiscordMember(apiError(50001, 403, 'Missing Access'))).toBe(false);
    expect(isUnknownDiscordMember(apiError(50014, 401, 'Invalid authentication token provided'))).toBe(false);
  });

  it('is false for 50013 Missing Permissions', () => {
    expect(isUnknownDiscordMember(apiError(50013, 403, 'You lack permissions to perform that action'))).toBe(false);
  });

  it('is false for 130000 overloaded and for a plain 5xx', () => {
    // 130000 is documented as "Try again a little later", and a bare 5xx
    // carries code 0. Both are the retryable direction, which must land on
    // "unknown" so the crown write is blocked rather than reassigned.
    expect(isUnknownDiscordMember(apiError(130000, 503, 'API resource is currently overloaded. Try again a little later'))).toBe(false);
    expect(isUnknownDiscordMember(apiError(0, 502, 'General error'))).toBe(false);
  });

  it('is false for 10004 Unknown Guild - a guild the bot lost, not a user who left', () => {
    expect(isUnknownDiscordMember(apiError(10004, 404, 'Unknown Guild'))).toBe(false);
  });

  it('is false for a 404 that carries no code at all', () => {
    // `isTerminalDiscordError` treats a bare 404 as terminal. That is correct
    // for an EDIT of a message we already hold and wrong here, so this case
    // pins that the two do not share a rule: a 404 with no `code` is a source
    // that could not answer, not a member who left.
    expect(isUnknownDiscordMember({ status: 404, message: 'Not Found' })).toBe(false);
  });

  it('is false for a network failure, which carries no code and no status', () => {
    // A `TypeError` from a fetch proxy, a dropped socket, an AbortError. None
    // of these is an answer, so all of them must report "could not ask".
    expect(isUnknownDiscordMember(new Error('socket hang up'))).toBe(false);
    expect(isUnknownDiscordMember(new TypeError('fetch failed'))).toBe(false);
  });

  it('is false, and does not throw, for values that are not error objects', () => {
    // The callers run inside a `catch` around a Discord call, and this predicate
    // must never be the thing that turns a fetch failure into a different one.
    expect(isUnknownDiscordMember('Unknown Member')).toBe(false);
    expect(isUnknownDiscordMember(null)).toBe(false);
    expect(isUnknownDiscordMember(undefined)).toBe(false);
    expect(isUnknownDiscordMember(10007)).toBe(false);
  });
});
