import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/bot/index.ts` — the process entrypoint.
 *
 * It is 37 lines, and it is not a shim. It does four things that are each a real
 * decision rather than ceremony:
 *
 *  1. `dns.setDefaultResultOrder('ipv4first')` before anything else, so a host
 *     that answers AAAA before A does not make every outbound request pay for a
 *     dead IPv6 attempt;
 *  2. the `unhandledRejection` and `uncaughtException` handlers, registered
 *     HERE and nowhere else. `startup.ts` used to register them too, so every
 *     unhandled rejection was logged twice and pushed to the Discord error feed
 *     twice — doubling the most expensive path (a full error plus stack, written
 *     to disk) exactly when the process is already in trouble. The comment in
 *     `startup.ts` that says so is only worth anything if the count is checked,
 *     which is what the "exactly one" tests below do;
 *  3. the sharding branch, so a single-process deploy never spawns a manager and
 *     a sharded one never runs two gateways in one process;
 *  4. `Logger.fatal` + `process.exit(1)` when the boot cannot complete.
 *
 * Importing this module is the only way to reach any of it: `index.ts` has no
 * exports and the whole file is a side effect on import. So each test resets
 * the module registry and imports it again, and the process listeners it adds
 * are captured and removed afterwards rather than left to accumulate.
 *
 * A note on what can be observed. Vitest evaluates a `vi.mock` factory ONCE per
 * file, not once per `resetModules()`, so "was this module imported?" cannot be
 * answered by counting factory runs — the counter would read zero from the
 * second test onwards and the assertion would be decoration. What is observable
 * is what the imported module DID: `Startup.runAsync()` (the single side effect
 * of `shardWorker`) and `runShardManager()`.
 */

const hoisted = vi.hoisted(() => ({
  shouldShard: vi.fn((): boolean => false),
  runShardManager: vi.fn(async () => ({ started: true })),
  // `shardWorker` calls `Startup.runAsync()` at module scope, which builds the
  // entire DI graph and logs the bot in. Mocking `./startup` is what stops the
  // test process from becoming a second bot if the `./shardWorker` mock below
  // ever fails to apply, and it doubles as the signal that the worker module
  // really was imported.
  runStartup: vi.fn(async () => undefined),
}));

vi.mock('dns', () => ({ default: { setDefaultResultOrder: vi.fn() } }));


vi.mock('@domain/logging/logger', () => ({
  Logger: {
    error: vi.fn(),
    fatal: vi.fn(),
    flushLogFile: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@domain/logging/errorFeed', () => ({ reportFatalToDiscord: vi.fn() }));

import dns from 'dns';
import { Logger } from '@domain/logging/logger';
import { reportFatalToDiscord } from '@domain/logging/errorFeed';

type Listener = (...args: unknown[]) => void;

const EVENTS = ['unhandledRejection', 'uncaughtException'] as const;
type ProcessEvent = (typeof EVENTS)[number];

const listenersBefore: Record<ProcessEvent, Listener[]> = {
  unhandledRejection: process.listeners('unhandledRejection') as Listener[],
  uncaughtException: process.listeners('uncaughtException') as Listener[],
};

const addedListeners: Array<[ProcessEvent, Listener]> = [];

/**
 * `process.listeners` in @types/node has one OVERLOAD PER EVENT LITERAL and no
 * union overload, so passing a `ProcessEvent` fails to resolve at all - the cast
 * was never the problem. Narrowing to a literal per branch picks a real overload
 * and lets the two return types widen on their own, with no cast and no lie about
 * which event was asked about.
 */
const listenersOf = (event: ProcessEvent): readonly unknown[] =>
  event === 'uncaughtException'
    ? process.listeners('uncaughtException')
    : process.listeners('unhandledRejection');

const captureListeners = (): void => {
  for (const event of EVENTS) {
    // The values are only compared by identity and invoked, never inspected.
    for (const listener of listenersOf(event) as Listener[]) {
      if (!listenersBefore[event].includes(listener)) addedListeners.push([event, listener]);
    }
  }
};

const drainAddedListeners = (): void => {
  for (const [event, listener] of addedListeners.splice(0)) {
    process.removeListener(event, listener);
  }
};

const originalExit = process.exit;
let exitCalls: number[] = [];

beforeEach(() => {
  vi.resetModules();
  // `vi.doMock`, not `vi.mock`: the hoisted form is evaluated ONCE for the whole
  // file, so its factory never ran again after the first import and every
  // later test measured a counter that could not move. The un-hoisted form is
  // re-applied to the fresh module registry on each import, which is the only
  // way to ask "what did THIS import do?".
  vi.doMock('../shardManager', () => ({
    shouldShard: hoisted.shouldShard,
    runShardManager: hoisted.runShardManager,
  }));
  vi.doMock('../shardWorker', () => {
    void hoisted.runStartup();
    return {};
  });
  vi.doMock('../startup', () => ({ Startup: { runAsync: hoisted.runStartup } }));
  hoisted.shouldShard.mockReset();
  hoisted.shouldShard.mockReturnValue(false);
  hoisted.runShardManager.mockReset();
  hoisted.runShardManager.mockResolvedValue({ started: true });
  hoisted.runStartup.mockClear();
  vi.mocked(dns.setDefaultResultOrder).mockClear();
  vi.mocked(Logger.error).mockClear();
  vi.mocked(Logger.fatal).mockClear();
  vi.mocked(Logger.flushLogFile).mockClear();
  vi.mocked(reportFatalToDiscord).mockClear();
  exitCalls = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
  drainAddedListeners();
});

/** Import the entrypoint fresh and let its unawaited `bootstrap()` settle. */
const boot = async (): Promise<void> => {
  await import('..');
  captureListeners();
  // One macrotask is enough for `await import(...)` inside `bootstrap`, and a
  // fixed wait beats a polling `waitFor` here: `waitFor` retries for a second
  // before failing, which turns a clean assertion into a one-second stall.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const addedListenerFor = (event: ProcessEvent): Listener | undefined =>
  (listenersOf(event) as Listener[]).find((listener) => !listenersBefore[event].includes(listener));

describe('index.ts — DNS result order', () => {
  it('pins ipv4first before anything else is imported', async () => {
    await boot();
    expect(dns.setDefaultResultOrder).toHaveBeenCalledTimes(1);
    expect(dns.setDefaultResultOrder).toHaveBeenCalledWith('ipv4first');
  });
});

describe('index.ts — the fatal handlers', () => {
  it('registers exactly one unhandled-rejection handler', async () => {
    // Two is the bug `startup.ts` shipped: the same rejection logged twice and
    // pushed to the error feed twice, at the exact moment the process is least
    // able to afford the cost.
    await boot();
    expect(addedListenerFor('unhandledRejection')).toBeDefined();
    expect(addedListeners.filter(([event]) => event === 'unhandledRejection')).toHaveLength(1);
  });

  it('registers exactly one uncaught-exception handler', async () => {
    await boot();
    expect(addedListenerFor('uncaughtException')).toBeDefined();
    expect(addedListeners.filter(([event]) => event === 'uncaughtException')).toHaveLength(1);
  });

  it('reports an unhandled rejection to the log and the error feed', async () => {
    await boot();
    const listener = addedListenerFor('unhandledRejection');
    expect(listener).toBeDefined();

    const reason = new Error('a promise gave up');
    listener?.(reason);

    expect(Logger.error).toHaveBeenCalledWith({ err: reason }, 'Unhandled promise rejection intercepted in process');
    expect(reportFatalToDiscord).toHaveBeenCalledWith('unhandledRejection', reason);
  });

  it('reports an uncaught exception AND flushes the buffered log before the process dies', async () => {
    // Log lines are buffered and flushed on an interval. A hard exit that does
    // not flush loses the tail that explains WHY the process died — which is
    // the only part anyone reads.
    await boot();
    const listener = addedListenerFor('uncaughtException');
    expect(listener).toBeDefined();

    const error = new Error('boom');
    listener?.(error);

    expect(Logger.fatal).toHaveBeenCalledWith({ err: error }, 'Uncaught exception intercepted in process');
    expect(reportFatalToDiscord).toHaveBeenCalledWith('uncaughtException', error);
    expect(Logger.flushLogFile).toHaveBeenCalledTimes(1);
  });

  it('does not flush the log for an unhandled rejection', async () => {
    // Only a hard exit loses the buffer. Flushing on every rejection would make
    // a sync write the price of any stray promise, which is how a small leak
    // becomes an I/O storm.
    await boot();
    addedListenerFor('unhandledRejection')?.(new Error('a promise gave up'));
    expect(Logger.flushLogFile).not.toHaveBeenCalled();
  });

  it('lets a throwing error feed surface instead of swallowing the crash', async () => {
    // `reportFatalToDiscord` runs inside the handler for an already-fatal event.
    // If it throws, the throw is what propagates — which is the honest outcome,
    // because a swallowed crash is an unreported one.
    await boot();
    vi.mocked(reportFatalToDiscord).mockImplementationOnce(() => {
      throw new Error('the webhook is down');
    });

    expect(() => addedListenerFor('uncaughtException')?.(new Error('boom'))).toThrow('the webhook is down');
  });
});

describe('index.ts — the sharding branch', () => {
  it('boots one shard worker in-process when sharding is off', async () => {
    hoisted.shouldShard.mockReturnValue(false);

    await boot();

    expect(hoisted.runStartup).toHaveBeenCalledTimes(1);
    expect(hoisted.runShardManager).not.toHaveBeenCalled();
  });

  it('runs the shard manager when sharding is on, and never starts a worker here', async () => {
    hoisted.shouldShard.mockReturnValue(true);

    await boot();

    expect(hoisted.runShardManager).toHaveBeenCalledTimes(1);
    expect(hoisted.runStartup).not.toHaveBeenCalled();
  });

  it('asks the sharding flag exactly once and acts on that answer', async () => {
    // A second read could disagree with the first, and the two branches do
    // mutually exclusive things: one spawns N child processes, the other opens
    // a gateway in this one.
    await boot();
    expect(hoisted.shouldShard).toHaveBeenCalledTimes(1);
  });
});

describe('index.ts — a bootstrap that cannot complete', () => {
  it('logs the real cause and exits non-zero instead of hanging', async () => {
    hoisted.shouldShard.mockReturnValue(true);
    const cause = new Error('could not spawn shard workers');
    hoisted.runShardManager.mockRejectedValue(cause);

    await boot();

    expect(Logger.fatal).toHaveBeenCalledWith(
      { err: cause },
      'Fatal error during bootstrap import',
    );
    expect(exitCalls).toEqual([1]);
    // The fatal path is the only place the process is allowed to exit, so
    // nothing else in the file may claim it.
    expect(hoisted.runStartup).not.toHaveBeenCalled();
  });

  it('does not exit when the boot succeeds', async () => {
    await boot();
    expect(hoisted.runStartup).toHaveBeenCalledTimes(1);
    expect(Logger.fatal).not.toHaveBeenCalled();
    expect(exitCalls).toEqual([]);
  });
});
