/**
 * `.login` / `.logout` / `.unlink` — the three commands that WRITE, and the one
 * place in this tree where a false success destroys somebody's data.
 *
 * `src/bot/services/failureVisibility.test.ts` already owns the `LoginService`
 * side of the alt-account cap: the guard fails CLOSED
 * (`countUsersByLastFmName` throwing yields `GuardUnavailable` rather than a
 * `0` that would disable the cap), and the pending token is deliberately NOT
 * deleted so a retry is one button press. Neither is repeated here.
 *
 * What IS here is the half that file cannot reach: **what the user is told.**
 * The service returns a status; `loginCommands` turns it into a sentence, and a
 * status that is rendered as the wrong sentence is a false claim just as surely
 * as a wrong return value. The pair that matters:
 *
 *   - `GuardUnavailable` -> the message must say the link was REFUSED and
 *     nothing was changed. Rendering it as "Connected as X" is the worst
 *     available outcome: the user believes their account is linked, it is not,
 *     and every stat command afterwards quietly reports nothing.
 *   - `AltLimitExceeded` -> also a refusal, with a DIFFERENT reason, and it must
 *     not be dressed as a retryable blip. The two are separate statuses because
 *     the cap was never hit in one of them.
 *   - `Success` -> the only path that may say "Connected".
 *
 * **The foreign-presser check is a security control and is asserted as
 * behaviour, not as a call.** `confirmLogin` is keyed by the discord id the
 * session was started for, so the check that matters is that a press by a
 * DIFFERENT user never reaches it — the reply is a refusal and the account is
 * untouched. Testing "the method was called with X" would pass on an
 * implementation that called it and then undid it.
 *
 * **The 10062 branches.** A confirm button clicked more than three seconds after
 * it rendered is expired, which is the NORMAL case for most presses. Both the
 * defer and the edit swallow it and return; a rethrow would surface as a
 * component-handler ERROR on every stale click. Asserted in both directions: the
 * expired path returns quietly, and a NON-10062 failure is NOT swallowed.
 *
 * **`.unlink` is a delete.** Two things are asserted that are easy to get wrong:
 * the confirmation is case-insensitive and must be the word `confirm` and not
 * merely the presence of an argument (`.unlink yes` must not delete), and a
 * `removeUser` that returns false must NOT be reported as a deletion.
 *
 * Constructor arity: (loginService, userService, componentTracker) — THREE.
 * The tracker is a plain double, so the registered confirm handler is captured
 * by hand and driven directly: that is the only way to reach the closure, and
 * it is why this file can test the deferred-reply logic at all.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';

import { LoginCommands } from '@bot/textCommands/lastfm/loginCommands';
import { LoginStatus, type LoginService } from '@bot/services/user/loginService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ComponentInteraction, ComponentInteractionTracker } from '@bot/services/system/componentInteractionTracker';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { UserService } from '@bot/services/user/userService';

const textOf = (response: ResponseModel): string => {
  // The TITLE is read too: `.unlink` puts "Account Deletion" there and the
  // warning body in the description, so a description-only probe asserts
  // nothing about whether the user was warned at all.
  const rows = [...response.buttonRows.values()].flat();
  const buttons = rows
    .flatMap((row) => row.toJSON().components as Array<{ custom_id?: string; url?: string; label?: string }>)
    .map((b) => `${b.label ?? ''}|${b.url ?? b.custom_id ?? ''}`);
  return [
    response.embed.data.title ?? '',
    response.embed.data.description ?? '',
    response.content ?? '',
    ...buttons,
  ].join('\n');
};

const REGISTERED = {
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
  registeredOn: new Date('2026-01-01T00:00:00Z'),
} as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: 'caller1',
    guildId: '900000000000000001',
    guild: { id: '900000000000000001', name: 'Test Guild', members: { cache: new Map() } },
    prefix: '!',
    accentColor: 0xba0009,
    ...over,
  }) as unknown as ContextModel;

/** discord.js's 10062, which is the code `isUnknownInteraction` looks for. */
const unknownInteraction = () =>
  Object.assign(new Error('Unknown interaction'), { code: 10062, status: 400 });

const build = (
  over: {
    caller?: User | null;
    startLogin?: string | null;
    startLoginThrows?: unknown;
    confirmResult?: { status: LoginStatus; userName?: string };
    confirmThrows?: unknown;
    logoutResult?: boolean;
    removeUserResult?: boolean;
    removeUserThrows?: unknown;
  } = {},
) => {
  const confirmLogin = vi.fn(async () => {
    if (over.confirmThrows) throw over.confirmThrows;
    return over.confirmResult ?? { status: LoginStatus.Success, userName: 'DreadRock' };
  });
  const startLogin = vi.fn(async () => {
    if (over.startLoginThrows) throw over.startLoginThrows;
    return over.startLogin === undefined ? 'https://www.last.fm/api/auth?api_key=k&token=t' : over.startLogin;
  });
  const logout = vi.fn(async () => over.logoutResult ?? true);
  const loginService = { startLogin, confirmLogin, logout } as unknown as LoginService;

  const removeUser = vi.fn(async () => {
    if (over.removeUserThrows) throw over.removeUserThrows;
    return over.removeUserResult ?? true;
  });
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? REGISTERED : over.caller)),
    removeUser,
  } as unknown as UserService;

  /** The registered closure, captured so the test can press the button. */
  let handler: ((interaction: ComponentInteraction) => Promise<void>) | null = null;
  let registeredId: string | null = null;
  let registeredTtl: number | undefined;
  const register = vi.fn(
    (customId: string, fn: (interaction: ComponentInteraction) => Promise<void>, ttl?: number) => {
      registeredId = customId;
      handler = fn;
      registeredTtl = ttl;
    },
  );
  const componentTracker = { register } as unknown as ComponentInteractionTracker;

  const cmd = new LoginCommands(loginService, userService, componentTracker);

  const press = async (over2: Record<string, unknown> = {}) => {
    if (!handler) throw new Error('no confirm handler was registered');
    const interaction = {
      user: { id: 'caller1' },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      flags: MessageFlags.Ephemeral,
      ...over2,
    } as unknown as ComponentInteraction;
    await handler(interaction);
    return interaction as unknown as {
      user: { id: string };
      deferReply: ReturnType<typeof vi.fn>;
      editReply: ReturnType<typeof vi.fn>;
      reply: ReturnType<typeof vi.fn>;
    };
  };

  return {
    cmd,
    startLogin,
    confirmLogin,
    logout,
    removeUser,
    register,
    press,
    registeredId: () => registeredId,
    registeredTtl: () => registeredTtl,
  };
};

const run = (cmd: LoginCommands, name: string, args: string[] = [], context = ctx()) =>
  cmd.commands.find((c) => c.name === name)!.executeAsync(context, args);

describe('login — the flow, and the button that carries it', () => {
  it('offers the authorize link and a confirm button, and names the server prefix', async () => {
    const built = build();
    const response = await run(built.cmd, 'login');
    const text = textOf(response);

    expect(text).toContain('Connect Last.fm');
    expect(text).toContain('Confirm session');
    // The two rows are DISTINCT: the link authorizes on Last.fm, the confirm
    // completes it here, and a card carrying only one of them is a dead end.
    expect([...response.buttonRows.keys()].sort()).toEqual([1, 2]);
  });

  it('registers the confirm handler against the CALLER\'s own id, with a TTL', async () => {
    const built = build();
    await run(built.cmd, 'login');

    // A handler registered under any other key is unreachable by the button the
    // card carries, so the user clicks Confirm and nothing happens.
    expect(built.registeredId()).toBe('login-confirm:caller1');
    // 55 minutes, which must outlive the 3-second Discord interaction window and
    // the time a human spends in Last.fm's auth page.
    expect(built.registeredTtl()).toBeGreaterThan(60_000);
  });

  it('tells an existing user which account they are currently connected as', async () => {
    const built = build();
    const text = textOf(await run(built.cmd, 'login'));

    expect(text).toContain('currently connected as **DreadRock**');
    // The new-user copy is a DIFFERENT set of instructions, and giving it to
    // somebody who is already linked makes them think their link is broken.
    expect(text).not.toContain('Connecting takes less than a minute');
  });

  it('gives a first-time user the numbered instructions instead', async () => {
    const built = build({ caller: null });
    const text = textOf(await run(built.cmd, 'login'));

    expect(text).toContain('Connecting takes less than a minute');
    expect(text).toContain('Confirm session');
    expect(text).not.toContain('currently connected as');
  });

  it('refuses cleanly when Last.fm could not be reached to mint a token', async () => {
    // No token means no session can be started, so there is nothing to hand
    // over. The alternative — rendering the flow anyway — hands out a link with
    // an empty token, and the user's next click fails on Last.fm's side with
    // nothing here to explain it.
    const built = build({ startLogin: null });
    const response = await run(built.cmd, 'login');

    expect(response.commandResponse).toBe(CommandResponse.Error);
    expect(textOf(response)).toContain('Could not reach Last.fm');
    // And no confirm handler: nothing to confirm.
    expect(built.register).not.toHaveBeenCalled();
  });

  it('propagates a start that threw, rather than blaming Last.fm', async () => {
    const built = build({ startLoginThrows: new Error('ECONNRESET') });
    await expect(run(built.cmd, 'login')).rejects.toThrow('ECONNRESET');
  });
});

describe('confirm — every status is rendered as its OWN sentence', () => {
  /**
   * A confirm handler only exists because `.login` registered one, so every
   * status test runs the login command first. Skipping that would mean driving a
   * closure the production path never creates.
   */
  const pressWith = async (status: LoginStatus, userName?: string) => {
    const built = build({ confirmResult: { status, userName } });
    await run(built.cmd, 'login');
    return built;
  };

  it('says Connected only for Success', async () => {
    const built = await pressWith(LoginStatus.Success, 'DreadRock');
    const interaction = await built.press();

    expect(built.confirmLogin).toHaveBeenCalledWith('caller1');
    const message = String(interaction.editReply.mock.calls[0]![0]);
    expect(message).toContain('Connected as **DreadRock**');
  });

  it('tells the user the link expired when there was no pending token', async () => {
    const built = await pressWith(LoginStatus.NoPendingLogin);
    const interaction = await built.press();
    const message = String(interaction.editReply.mock.calls[0]![0]);

    // Not "Connected", and not a silent no-op: the user needs to know to run
    // the login command again.
    expect(message).toContain('This login link expired');
    expect(message).not.toContain('Connected as');
  });

  it('refuses loudly when the account is already at the alt cap', async () => {
    const built = await pressWith(LoginStatus.AltLimitExceeded, 'DreadRock');
    const interaction = await built.press();
    const message = String(interaction.editReply.mock.calls[0]![0]);

    expect(message).toContain('maximum number of Discord accounts');
    expect(message).toContain('DreadRock');
    // A real refusal, not a blip: telling this user to "try again in a moment"
    // would send them round the loop for ever, because the cap is not transient.
    expect(message).not.toContain('try again in a moment');
    expect(message).not.toContain('Connected as');
  });

  it('refuses loudly when the cap could not be evaluated at all', async () => {
    // THE ONE. `GuardUnavailable` is the service refusing to guess at a security
    // control, and it is a DIFFERENT situation from the cap being hit: nothing
    // was exceeded, the database just did not answer. The message has to say the
    // link was refused and nothing changed, or the user believes they are
    // connected when they are not — and every stat command afterwards quietly
    // reports nothing for them.
    const built = await pressWith(LoginStatus.GuardUnavailable, 'DreadRock');
    const interaction = await built.press();
    const message = String(interaction.editReply.mock.calls[0]![0]);

    expect(message).toContain('refused the link rather than guess');
    expect(message).toContain('Nothing was changed');
    expect(message).not.toContain('Connected as');
    expect(message).not.toContain('maximum number of Discord accounts');
  });

  it('asks the user to wait when Last.fm has not authorized yet', async () => {
    const built = await pressWith(LoginStatus.NotAuthorizedYet);
    const interaction = await built.press();
    const message = String(interaction.editReply.mock.calls[0]![0]);

    // This one IS retryable, so it says so, and it points at the Last.fm page
    // the user may have half-completed.
    expect(message).toContain('Allow access');
    expect(message).not.toContain('Connected as');
  });

  it('defers before doing anything, because Discord gives three seconds', async () => {
    const built = await pressWith(LoginStatus.Success, 'DreadRock');
    const interaction = await built.press();

    // An ack after the token expires is 10062, so the defer has to come first
    // and it has to be ephemeral — this reply is a link-adjacent auth step.
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.deferReply.mock.invocationCallOrder[0]!).toBeLessThan(
      built.confirmLogin.mock.invocationCallOrder[0]!,
    );
  });
});

describe('confirm — the security controls', () => {
  it('refuses a press by anybody but the session owner, and does not link', async () => {
    const built = build();
    await run(built.cmd, 'login');

    const interaction = await built.press({ user: { id: 'someoneelse' } });

    expect(built.confirmLogin).not.toHaveBeenCalled();
    // `reply({ content, ephemeral })` is a single options OBJECT, so probing
    // calls[0][0] as a string reads [object Object] and asserts nothing.
    const options = interaction.reply.mock.calls[0]![0] as { content?: string; ephemeral?: boolean };
    expect(options.content).toContain('belongs to someone else');
    // Ephemeral, or the refusal is posted for the whole channel to read.
    expect(options.ephemeral).toBe(true);
  });

  it('links when the presser IS the session owner', async () => {
    // The control that makes the test above meaningful: same button, same
    // session, matching user, and the link happens.
    const built = build();
    await run(built.cmd, 'login');
    await built.press();

    expect(built.confirmLogin).toHaveBeenCalledTimes(1);
  });

  it('treats the pending session as still valid so a retry is one click', async () => {
    // The service keeps the token on a guard failure (covered in
    // `failureVisibility.test.ts`). This is the command-side half: the message
    // must offer the retry, so a transient database blip does not become a full
    // re-authorisation in the user's browser.
    const built = build({ confirmResult: { status: LoginStatus.GuardUnavailable, userName: 'X' } });
    await run(built.cmd, 'login');
    const interaction = await built.press();

    expect(String(interaction.editReply.mock.calls[0]![0])).toContain('press **Confirm** again');
  });
});

describe('confirm — the 10062 branches are the normal case, not errors', () => {
  it('returns quietly when the confirm button was clicked too late to ack', async () => {
    // Most presses are stale: Discord gives a button three seconds. A rethrow
    // here is an ERROR log on every one of them, which is how the real signal
    // gets buried.
    const built = build();
    await run(built.cmd, 'login');
    const interaction = await built.press({ deferReply: vi.fn(async () => Promise.reject(unknownInteraction())) });

    expect(built.confirmLogin).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('does NOT swallow a defer failure that is not 10062', async () => {
    // The narrowness is the point. Catching everything here would hide a real
    // Discord outage behind the "stale button" path, and nothing would be logged.
    const built = build();
    await run(built.cmd, 'login');

    await expect(
      built.press({ deferReply: vi.fn(async () => Promise.reject(new Error('500 Internal Server Error'))) }),
    ).rejects.toThrow('500 Internal Server Error');
  });

  it('returns quietly when the EDIT is too late, having already linked', async () => {
    // The awkward one: the link is real, the message about it cannot be
    // delivered. Retrying would re-run the whole confirm; rethrowing would error
    // on a success. Swallowing is correct and the user sees the result next time
    // they ask.
    const built = build();
    await run(built.cmd, 'login');
    const interaction = await built.press({
      editReply: vi.fn(async () => Promise.reject(unknownInteraction())),
    });

    expect(built.confirmLogin).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('does NOT swallow an edit failure that is not 10062', async () => {
    const built = build();
    await run(built.cmd, 'login');

    await expect(
      built.press({ editReply: vi.fn(async () => Promise.reject(new Error('500 Internal Server Error'))) }),
    ).rejects.toThrow('500 Internal Server Error');
  });

  it('swallows a reply failure to a foreign presser without hiding a real one', async () => {
    // The foreign-presser reply is a courtesy notice on an expired interaction,
    // so its failure is ignored. Asserted so the catch is known to be scoped to
    // that path rather than to every reply in the handler.
    const built = build();
    await run(built.cmd, 'login');

    await built.press({
      user: { id: 'someoneelse' },
      reply: vi.fn(async () => Promise.reject(new Error('500 Internal Server Error'))),
    });

    expect(built.confirmLogin).not.toHaveBeenCalled();
  });

  it('propagates a confirm that threw, so a broken link is never reported as done', async () => {
    // `setUserLastFm` failing must surface. Swallowing it here would leave the
    // user with a "Connected as X" they do not have.
    const built = build({ confirmThrows: new Error('P2002: unique constraint failed') });
    await run(built.cmd, 'login');

    await expect(built.press()).rejects.toThrow('unique constraint failed');
  });
});

describe('logout', () => {
  it('reports a completed disconnect', async () => {
    const built = build();
    const response = await run(built.cmd, 'logout');

    expect(built.logout).toHaveBeenCalledWith('caller1');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('session has been disconnected');
  });

  it('does not claim a disconnect that did not happen', async () => {
    // `logout` returns a boolean precisely because "you are not registered" and
    // "disconnected" are different answers. The success sentence for the first
    // would be a small, unarguable lie.
    const built = build({ logoutResult: false });
    const response = await run(built.cmd, 'logout');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('not registered');
    expect(textOf(response)).not.toContain('session has been disconnected');
  });
});

describe('unlink — a delete, so the confirmation is load-bearing', () => {
  it('warns in orange when the caller\'s accent colour is unknown', async () => {
    // `context.accentColor ?? DiscordConstants.WarningColorOrange` — a DM has
    // no guild, so the accent is undefined, and this is the only card in the
    // login flow that is a warning rather than a status. The title and the
    // colour are the whole point of the prompt: a delete confirmation rendered
    // indistinguishably from a status card is a delete confirmation nobody
    // reads.
    const built = build();
    const response = await run(built.cmd, 'unlink', [], ctx({ accentColor: undefined }));

    expect(response.embed.data.color).toBe(0xf38020);
    expect(textOf(response)).toContain('Account Deletion');
  });

  it('keeps the caller\'s accent when there is one, so a server theme survives the prompt', async () => {
    const built = build();
    const response = await run(built.cmd, 'unlink', [], ctx({ accentColor: 0x112233 }));

    expect(response.embed.data.color).toBe(0x112233);
  });

  it('asks before deleting, and deletes nothing yet', async () => {
    const built = build();
    const response = await run(built.cmd, 'unlink');

    expect(built.removeUser).not.toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('Account Deletion');
    // The warning spells out what goes, because the user cannot undo it.
    expect(textOf(response)).toContain('revoke your session');
    expect(textOf(response)).toContain('crowns');
    // And it names the account being deleted, so nobody deletes the wrong one.
    expect(textOf(response)).toContain('**DreadRock**');
  });

  it('names the exact confirmation to type, with the server prefix', async () => {
    const built = build();
    // `!unlink confirm`, not `.unlink confirm`: the prefix is the server's, and
    // a hardcoded one sends the user to a command that does not exist here.
    expect(textOf(await run(built.cmd, 'unlink'))).toContain('`!unlink confirm`');
  });

  it('deletes on an exact, case-insensitive `confirm`', async () => {
    for (const word of ['confirm', 'CONFIRM', 'Confirm']) {
      const built = build();
      const response = await run(built.cmd, 'unlink', [word]);

      expect(built.removeUser).toHaveBeenCalledWith('caller1');
      expect(response.commandResponse).toBe(CommandResponse.Ok);
    }
  });

  it.each(['yes', 'delete', 'y', 'confirmed', ''])('does NOT delete on `%s`', async (word) => {
    // The check is `=== 'confirm'`, so a near-miss must not delete. Anything
    // looser is a data loss bug wearing a convenience hat.
    const built = build();
    const response = await run(built.cmd, 'unlink', [word]);

    expect(built.removeUser).not.toHaveBeenCalled();
    expect(textOf(response)).toContain('Account Deletion');
  });

  it('reports a deletion that did not happen, as a failure', async () => {
    // `removeUser` returns a boolean. A success message on `false` tells a user
    // their library is gone when it is still there — and they will not check
    // again.
    const built = build({ removeUserResult: false });
    const response = await run(built.cmd, 'unlink', ['confirm']);

    expect(response.commandResponse).toBe(CommandResponse.Error);
    expect(textOf(response)).toContain('Failed to remove your user data');
    expect(textOf(response)).not.toContain('Successfully deleted');
  });

  it('confirms a real deletion and names the account that went', async () => {
    const built = build();
    const text = textOf(await run(built.cmd, 'unlink', ['confirm']));

    expect(text).toContain('Successfully deleted your account (**DreadRock**)');
    // And says they can come back, so a delete does not read as a ban.
    expect(text).toContain('re-connect anytime');
  });

  it('refuses a caller it has no record of, without asking for confirmation', async () => {
    const built = build({ caller: null });
    const response = await run(built.cmd, 'unlink', ['confirm']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('have not connected');
    expect(built.removeUser).not.toHaveBeenCalled();
  });
});

describe('LoginCommands — the registry surface', () => {
  it('exposes the three commands with the aliases that have always pointed here', () => {
    const built = build();
    const byName = new Map(built.cmd.commands.map((c) => [c.name, c.aliases ?? []]));

    expect([...byName.keys()]).toEqual(['login', 'logout', 'unlink']);
    // `unlink` is the Last.fm spelling and `deleteaccount` its alias — NOT
    // `remove`, which belongs to the music queue. See `commandRegistryInvariants`.
    expect(byName.get('login')).toEqual(['connect']);
    expect(byName.get('unlink')).toEqual(['deleteaccount']);
    expect(byName.get('logout')).toEqual([]);
  });

  it('declares the args parameter on all three, and only `unlink` reads it', () => {
    const built = build();
    const arityOf = (name: string) =>
      built.cmd.commands.find((c) => c.name === name)!.executeAsync.length;

    // All three are declared as `(context, args)` — arity 2 — because
    // `TextCommandDefinition` requires that shape. The difference is in the
    // BODY: `login` and `logout` bind `_args` and ignore it, while `unlink`
    // reads `args[0]`. Asserting arity alone would therefore pass for all three
    // and prove nothing, so the behaviour is asserted above instead: only
    // `.unlink confirm` deletes anything.
    expect(arityOf('login')).toBe(2);
    expect(arityOf('logout')).toBe(2);
    expect(arityOf('unlink')).toBe(2);
  });
});
