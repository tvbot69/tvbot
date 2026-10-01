/**
 * `/login` and `/logout` - the only place in the command layer where a WRITE to
 * a user's Last.fm identity happens, and the only one whose "did it work?"
 * answer is delivered by a BUTTON rather than by the response.
 *
 * The shape that makes this file necessary: `loginAsync` does not confirm
 * anything. It asks Last.fm for a token, renders a link, and registers a
 * confirm handler. The link is where the user learns nothing; the confirm
 * button is where the user learns something. So the interesting assertions
 * live on the handler's five branches, each of which must say something
 * DIFFERENT and must each be reached by a different `LoginStatus`.
 *
 * THE A1 TEST HERE IS `startLogin` returning null. `LoginService.startLogin`
 * returns null when `getAuthToken` gave nothing, which is a Last.fm
 * transport failure and not a "you are already linked" answer. Rendering a
 * login card anyway would hand the user a link to a page that cannot work, and
 * - worse - register a confirm handler whose only possible outcome is the
 * "does not show an authorized session yet" message. So: the failure is
 * reported, AND no handler is registered (a registered handler is a session
 * entry that outlives the failure, and the user pressing Confirm afterwards
 * would get a confusing "expired" instead of the real cause). Both halves.
 *
 * `GuardUnavailable` is the second one worth pinning, and it is the reason the
 * handler has five branches rather than two. It is NOT `AltLimitExceeded`: the
 * cap was never actually hit, the guard could not be evaluated, and the link
 * was refused. Answering "already linked to the maximum number of Discord
 * accounts" for it would tell the user to go and ask a bot owner for help with
 * something that is really a database blip.
 *
 * NOTHING IS SPIED ON. `componentTracker` is a plain object double handed to
 * the constructor, and the registered handler is retrieved by calling the
 * captured callback the way `ComponentInteractionTracker.handle` calls it -
 * which is the real production mechanism (a string-keyed map lookup, invisible
 * to grep).
 *
 * Constructor arity read from `loginSlashCommands.ts`:
 * (loginService, userService, componentTracker). Three positional arguments.
 */
import { describe, expect, it, vi } from 'vitest';
import { LoginSlashCommands } from '@bot/slashCommands/user/loginSlashCommands';
import { LoginStatus, type LoginService } from '@bot/services/user/loginService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { ComponentInteractionTracker } from '@bot/services/system/componentInteractionTracker';

const CALLER_ID = 'caller1';
const AUTH_URL = 'https://www.last.fm/api/auth?api_key=public-key&token=token-abc';

interface ConfirmHandler {
  (interaction: {
    user: { id: string };
    reply: (payload: unknown) => Promise<unknown>;
    deferReply: (payload?: unknown) => Promise<unknown>;
    editReply: (payload: unknown) => Promise<unknown>;
  }): Promise<void>;
}

const makeContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: CALLER_ID,
    guildId: '222',
    guild: { id: '222', name: 'Test Guild', members: { cache: { get: () => undefined } } },
    prefix: '/',
    accentColor: 0x445566,
    interaction: { channelId: 'text1', id: 'i1', commandName: 'login', user: { id: CALLER_ID } },
    ...over,
  }) as unknown as ContextModel;

/**
 * A button interaction double: every method the handler calls, recorded.
 *
 * Every mock takes `..._args: unknown[]` ON PURPOSE. A zero-parameter `vi.fn()`
 * infers a `[]` call tuple, so `editReply.mock.calls[0][0]` is a compile error
 * that vitest never reports - the file would pass locally and break the build.
 * Several assertions below read the argument back out.
 */
const makeButton = (id: string) => {
  const button = {
    user: { id },
    reply: vi.fn(async (..._args: unknown[]) => undefined),
    deferReply: vi.fn(async (..._args: unknown[]) => undefined),
    editReply: vi.fn(async (..._args: unknown[]) => undefined),
  };
  return button;
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return (
      response.componentsV2Container.toJSON() as { components: Array<{ content?: string }> }
    )
      .components.map((c) => c.content ?? '')
      .join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

const allButtonPayloads = (response: ResponseModel): string => JSON.stringify(response.toMessagePayload());

interface Doubles {
  authUrl?: string | null;
  existingUser?: { userNameLastFm: string } | null;
  confirmResult?: { status: LoginStatus; userName?: string };
  logout?: boolean;
}

const build = (over: Doubles = {}) => {
  const loginService = {
    startLogin: vi.fn(async (..._args: unknown[]) => (over.authUrl === undefined ? AUTH_URL : over.authUrl)),
    confirmLogin: vi.fn(async (..._args: unknown[]) =>
      over.confirmResult ?? { status: LoginStatus.Success, userName: 'DreadRock' },
    ),
    logout: vi.fn(async (..._args: unknown[]) => (over.logout === undefined ? true : over.logout)),
  } as unknown as LoginService;
  const userService = {
    // `=== undefined` rather than `??`, so an explicit `existingUser: null` (a
    // caller who has NOT connected an account) stays null instead of being
    // replaced by the default. `??` would have made the fresh-user case below
    // unreachable, and it would have passed for the wrong reason.
    getUserByDiscordId: vi.fn(async () =>
      over.existingUser === undefined ? { userNameLastFm: 'DreadRock' } : over.existingUser,
    ),
  } as unknown as UserService;
  const registered: Array<{ customId: string; handler: ConfirmHandler; ttlMs: number | undefined }> = [];
  const componentTracker = {
    register: vi.fn((customId: string, handler: ConfirmHandler, ttlMs?: number) => {
      registered.push({ customId, handler, ttlMs });
    }),
  } as unknown as ComponentInteractionTracker;

  const cmd = new LoginSlashCommands(loginService, userService, componentTracker);
  const privates = cmd as unknown as {
    loginAsync(c: ContextModel): Promise<ResponseModel>;
    logoutAsync(c: ContextModel): Promise<ResponseModel>;
  };
  return { cmd, privates, loginService, userService, componentTracker, registered };
};

const commandOf = (cmd: LoginSlashCommands, name: string) => {
  const found = cmd.commands.find((c) => c.data.toJSON().name === name);
  if (!found) throw new Error(`command ${name} is not registered`);
  return found;
};

describe('/login: a Last.fm that will not issue a token must say so, and leave no confirm button behind', () => {
  it('reports the failed start rather than rendering a link that cannot work', async () => {
    const { privates } = build({ authUrl: null });
    const response = await privates.loginAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Error);
    expect(cardText(response)).toContain('Could not reach Last.fm to start the login flow');
  });

  it('registers NO confirm handler when the start failed', async () => {
    // The second half of the pair, and the part a `toContain` assertion cannot
    // see. A handler registered against a start that failed is a session entry
    // that outlives the failure: the user clicks Confirm minutes later and is
    // told the link expired, which names neither the real cause nor the fact
    // that a retry will work.
    const { privates, componentTracker, registered } = build({ authUrl: null });
    await privates.loginAsync(makeContext());

    expect(componentTracker.register).not.toHaveBeenCalled();
    expect(registered).toHaveLength(0);
  });

  it('offers the link and a Confirm button when Last.fm does issue a token', async () => {
    // And the ordinary path still works, so the refusal above is not a blanket
    // one. Asserted on the rendered payload, because the two buttons are the
    // whole feature: a link the user can click and a callback bound to THEIR id.
    const { privates, registered } = build();
    const response = await privates.loginAsync(makeContext());

    const payload = allButtonPayloads(response);
    expect(payload).toContain(AUTH_URL);
    expect(payload).toContain(`login-confirm:${CALLER_ID}`);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.customId).toBe(`login-confirm:${CALLER_ID}`);
  });

  it('keeps the confirm session alive for the length of the Last.fm token, not the default', async () => {
    // `LoginService` stores the pending token for 3300s. A shorter tracker TTL
    // would expire the button while the token is still valid, and the user would
    // be told to run /login again for no reason; a longer one would let a
    // confirm attempt sit on a token Last.fm has already dropped.
    const { privates, registered } = build();
    await privates.loginAsync(makeContext());
    expect(registered[0]!.ttlMs).toBe(3300000);
  });

  it('tells an already-linked user who they are connected as, and a new one how to connect', async () => {
    // Both intros are real answers and they are different answers. Rendering the
    // first-time steps to someone who is already connected reads as though
    // their link was lost, and rendering the "currently connected as" line to
    // someone who is not is a claim about their account the bot cannot support.
    const linked = build({ existingUser: { userNameLastFm: 'DreadRock' } });
    expect(cardText(await linked.privates.loginAsync(makeContext()))).toContain(
      'currently connected as **[DreadRock]',
    );

    const fresh = build({ existingUser: null });
    const text = cardText(await fresh.privates.loginAsync(makeContext()));
    expect(text).toContain('Click **Connect Last.fm**');
    expect(text).not.toContain('currently connected as');
  });
});

describe('the Confirm button: five outcomes, five different messages', () => {
  /** Runs `/login`, then presses the button as `pressingUser`. */
  const confirmAs = async (over: Doubles, pressingUser = CALLER_ID) => {
    const built = build(over);
    await built.privates.loginAsync(makeContext());
    const button = makeButton(pressingUser);
    await built.registered[0]!.handler(button);
    return { ...built, button };
  };

  it('refuses a click from somebody else and never reaches the login service', async () => {
    const { loginService, button } = await confirmAs({}, 'someone-else');

    expect(button.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'This login session belongs to someone else.' }),
    );
    expect(loginService.confirmLogin).not.toHaveBeenCalled();
    expect(button.deferReply).not.toHaveBeenCalled();
  });

  it('confirms a link and names the account that was connected', async () => {
    const { loginService, button } = await confirmAs({
      confirmResult: { status: LoginStatus.Success, userName: 'DreadRock' },
    });

    expect(button.deferReply).toHaveBeenCalled();
    expect(loginService.confirmLogin).toHaveBeenCalledWith(CALLER_ID);
    expect(String(button.editReply.mock.calls[0]![0])).toContain('Connected as **DreadRock**');
  });

  it('says the link expired when there was no pending login to confirm', async () => {
    const { button } = await confirmAs({ confirmResult: { status: LoginStatus.NoPendingLogin } });
    expect(String(button.editReply.mock.calls[0]![0])).toContain('This login link expired');
  });

  it('blames the alt-account cap for a real cap breach, and asks for a bot owner', async () => {
    const { button } = await confirmAs({
      confirmResult: { status: LoginStatus.AltLimitExceeded, userName: 'SharedAccount' },
    });
    const text = String(button.editReply.mock.calls[0]![0]);
    expect(text).toContain('**SharedAccount**');
    expect(text).toContain('maximum number of Discord accounts');
    expect(text).toContain('bot owner');
  });

  it('blames an UNEVALUATED guard on the guard, never on the cap', async () => {
    // The distinction is the whole reason this branch exists. `AltLimitExceeded`
    // tells the user their account is shared by five Discord rows, which is a
    // claim about the DATABASE that was never established - and it sends them
    // to a bot owner for a blip. `GuardUnavailable` has to say the bot could
    // not find out, and that nothing was changed.
    const { button } = await confirmAs({
      confirmResult: { status: LoginStatus.GuardUnavailable, userName: 'DreadRock' },
    });
    const text = String(button.editReply.mock.calls[0]![0]);
    expect(text).toContain('could not verify how many Discord accounts');
    expect(text).toContain('Nothing was changed');
    expect(text).not.toContain('maximum number of Discord accounts');
  });

  it('asks whether the user clicked Allow access when Last.fm has no session yet', async () => {
    const { button } = await confirmAs({ confirmResult: { status: LoginStatus.NotAuthorizedYet } });
    const text = String(button.editReply.mock.calls[0]![0]);
    expect(text).toContain('does not show an authorized session yet');
    expect(text).toContain('Allow access');
  });

  it('replies exactly once per status, so no branch can fall through into another', async () => {
    // The five branches are a chain of `if (status === ...) return`, and a chain
    // is only as good as its last link: dropping a `return` would make the
    // unknown-status fallback speak over a real outcome. One editReply per
    // press is what pins the chain.
    for (const status of [
      LoginStatus.Success,
      LoginStatus.NoPendingLogin,
      LoginStatus.AltLimitExceeded,
      LoginStatus.GuardUnavailable,
      LoginStatus.NotAuthorizedYet,
    ]) {
      const { button } = await confirmAs({ confirmResult: { status } });
      expect(button.editReply).toHaveBeenCalledTimes(1);
    }
  });
});

describe('/logout', () => {
  it('reports a disconnect when the session key was actually cleared', async () => {
    const { privates, loginService } = build({ logout: true });
    const response = await privates.logoutAsync(makeContext());

    expect(loginService.logout).toHaveBeenCalledWith(CALLER_ID);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('has been disconnected');
  });

  it('says there was nothing to disconnect rather than claiming a success', async () => {
    // The A1 direction for a WRITE. `logout` returns false when no row was
    // found, which is a real "not registered" - and the card must say that.
    // Answering "your session has been disconnected" to a user who never
    // connected one is a confident claim about a write that did not happen.
    const { privates } = build({ logout: false });
    const response = await privates.logoutAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('not registered with the bot');
  });

  it('marks both commands ephemeral, because a login link is not for the channel', async () => {
    // A non-ephemeral /login would print someone's Last.fm authorize token into
    // a shared channel, where it stays in history and stays clickable.
    const { cmd } = build();
    expect(commandOf(cmd, 'login').ephemeral).toBe(true);
    expect(commandOf(cmd, 'logout').ephemeral).toBe(true);
  });
});
