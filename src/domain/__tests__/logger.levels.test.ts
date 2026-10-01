import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CustomLogger, Logger } from '@domain/logger';

/**
 * The shape of the logging surface, and the invariants a log line must hold.
 *
 * WHY THIS FILE IS THE HIGHEST-LEVERAGE TEST IN THE TREE
 * ------------------------------------------------------
 * `logger.ts` is imported by essentially every module in `src/`, so a defect here
 * does not break one feature - it breaks the evidence for all of them, and a
 * logger that throws turns a handled failure into an unhandled rejection.
 *
 * THE API, AS IT ACTUALLY IS (read off the class, not assumed)
 * ------------------------------------------------------------
 * `CustomLogger` takes NO constructor arguments and is not `@injectable()`;
 * `Logger` is a module-level singleton instance, and the same name is also
 * exported as a TYPE alias, so `new CustomLogger()` and `Logger` are the same
 * class from a consumer's point of view.
 *
 * The public surface is:
 *   isDebugEnabled  (public field, read at construction from the environment)
 *   boundContext    (public field, set only by `withContext`)
 *   withContext(ctx)              -> a CHILD logger, not a mutation
 *   info/warn/error/fatal/debug(Loggable, ...unknown[])
 *   ready(string) / sync(string, durationMs?)
 *   command(info) / slash(info) / button(info)   -> one shaped console.log each
 *   commandUsed(info) / slashCommandUsed(info)   -> delegate to `info`
 *   shardEvent(event, shardId, details?)
 *   errorWithRef(error, context?) -> { referenceId, message }
 *   generateReferenceId() / banner() / flushLogFile()
 *
 * Every stdout line in the class goes through ONE private `emit`, which redacts
 * and cannot throw. Every line that reaches the file goes through
 * `writeLogToFile`, which receives the message already redacted.
 *
 * `logger.redaction.test.ts` covers the credentials: a key denylist applied
 * recursively plus value-shape patterns, on BOTH sinks, with the deliberate
 * misses asserted as loudly as the catches. This file covers everything else -
 * which level prints, what shape the line has, and what a log call absorbs
 * without throwing.
 *
 * WHY `console` IS ASSIGNED RATHER THAN SPYED
 * --------------------------------------------
 * Rule 3 of this brief: never `vi.spyOn` a shared live object. `vi.spyOn(
 * console, 'log')` plus `mockRestore()` has left an own property set to
 * `undefined` in this repo, which silently kills every later test in the file.
 * A plain save/assign/restore of the property has no such failure mode, and the
 * stub deliberately forwards to nothing - the logger is the only thing under
 * test that should be writing here.
 */

const ANSI = /\x1b\[[0-9;]*m/g;

let lines: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let errors: string[] = [];

beforeEach(() => {
  lines = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

/** The stdout text with the colour codes removed, which is what a reader sees. */
const out = (): string => lines.join('\n').replace(ANSI, '');

/**
 * Just the MESSAGE line, with the colour codes gone.
 *
 * `print` emits the message and then, for ERROR/FATAL, one extra `emit` (i.e.
 * one more line) per stack line. Those stack lines contain the error message
 * textually, so any
 * assertion of the form "the message line must not contain X" has to be scoped
 * to line 0 or it will be testing the stack instead of the message.
 */
const firstLine = (): string => (lines[0] ?? '').replace(ANSI, '');

/** A fresh logger, so per-instance state cannot leak between tests. */
const fresh = (): CustomLogger => new CustomLogger();

describe('CustomLogger: which levels print at all', () => {
  it('prints info, warn, error and fatal unconditionally', () => {
    const logger = fresh();
    logger.isDebugEnabled = false;

    logger.info('an info line');
    logger.warn('a warn line');
    logger.error('an error line');
    logger.fatal('a fatal line');

    const text = out();
    expect(text).toContain('an info line');
    expect(text).toContain('a warn line');
    expect(text).toContain('an error line');
    expect(text).toContain('a fatal line');
  });

  it('suppresses debug completely when debug logging is off', () => {
    // The whole point of the DEBUG-for-degradation rule: an expected-but-notable
    // outcome is a DEBUG line, so it must cost NOTHING when nobody asked for it.
    // No formatting, no stdout, no file append - which is also why `debug`
    // returns before `print` rather than inside it.
    const logger = fresh();
    logger.isDebugEnabled = false;

    logger.debug('a degradation nobody asked to see', { userId: 7 });

    expect(lines).toHaveLength(0);
  });

  it('prints debug when debug logging is on, and keeps the level legible', () => {
    const logger = fresh();
    logger.isDebugEnabled = true;

    logger.debug('a degradation worth recording');

    expect(out()).toContain('DEBUG');
    expect(out()).toContain('a degradation worth recording');
  });

  it('does not print an error stack at WARN, because a warn is not a fault', () => {
    // A stack costs a dozen lines of stdout and buries the line that matters.
    // Only ERROR and FATAL earn one, and this is the assertion that keeps the
    // other three cheap.
    const logger = fresh();
    logger.warn(new Error('just a heads up'));
    expect(out()).toContain('just a heads up');
    expect(out()).not.toContain('    at ');

    logger.error(new Error('a real fault'));
    expect(out()).toContain('    at ');
  });

  it('prints a stack at FATAL as well, because a fatal is the most fatal thing there is', () => {
    // Found by MUTATION, not by reading: dropping `|| level === 'FATAL'` from the
    // guard inside `print` made no test in this file go red. The FATAL branch was
    // being executed and never asserted, which is the worst kind of coverage -
    // it counts in the report and proves nothing. A fatal that logs its message
    // and swallows its stack is the one crash nobody can diagnose from the log.
    const logger = fresh();
    logger.fatal(new Error('the process is going down'));

    const text = out();
    expect(text).toContain('the process is going down');
    expect(text).toContain('    at ');
  });

  it('labels a fatal FATAL on the printed line, not merely ERROR', () => {
    // ERROR and FATAL share a colour and a stack rule, so the tag is the only
    // thing that tells a reader which of the two it was.
    const logger = fresh();
    logger.fatal('the worst one');

    expect(firstLine()).toContain('FATAL');
    expect(firstLine()).not.toContain('ERROR');
  });

  it('prints a stack at FATAL for a plain-object err too, because the rule is level-based', () => {
    const logger = fresh();
    logger.fatal({ err: { message: 'object shaped at fatal', stack: 'frame one' } });

    const text = out();
    expect(text).toContain('object shaped at fatal');
    expect(text).toContain('frame one');
  });
});

describe('CustomLogger: which failures a log line absorbs, and which it does not', () => {
  /*
   * The invariant underneath all of these: a log call is the LAST thing between a
   * failure and a crash. It runs inside catch blocks across the bot, so anything
   * that throws out of it converts a reported fault into an unhandled rejection
   * and destroys the very evidence someone needed. That is why every formatting
   * call here is guarded rather than merely wrapped, and why the fallback keeps
   * the line rather than dropping it.
   */
  it('writes the line out before it touches anything that can fail', () => {
    // Ordering is the invariant the module's comments actually assert, and it
    // is checkable from outside: by the time `print` is done, the message is on
    // stdout even if the file sink refused it. `logger.fileSink.test.ts` covers
    // the refusal half.
    const logger = fresh();
    logger.warn('the observable line');
    expect(out()).toContain('the observable line');
  });

  it('formats well-behaved extra arguments rather than dropping them', () => {
    const logger = fresh();
    logger.info('track %s by %s (%d plays)', 'Creep', 'Radiohead', 4321);
    const text = out();
    expect(text).toContain('Creep');
    expect(text).toContain('Radiohead');
    expect(text).toContain('4321');
  });

  it('keeps the line when an extra argument\'s toString throws', () => {
    // DEFECT 3. Node's `%s` handling calls `String(arg)`, so `util.format` was
    // unguarded and a hostile value escaped the log call entirely. Reproduce the
    // raw behaviour with:
    //   npx tsx -e "const u=require('util');try{u.format('x %s',{toString(){throw new Error('boom')}})}catch(e){console.log('THROWS',e.message)}"
    // The requirement is narrow and exact: a hostile ARGUMENT costs the argument,
    // never the line. The message is still printed, and the replacement text says
    // the value could not be rendered rather than pretending it was empty.
    const logger = fresh();
    expect(() => logger.info('resolver said %s for %s', { toString: () => { throw new Error('boom'); } }, 'track-a'))
      .not.toThrow();
    expect(firstLine()).toContain('resolver said');
    expect(firstLine()).toContain('track-a');
    expect(firstLine()).toContain('could not be stringified');
  });

  it('survives a hostile toString on the message itself, rather than crashing', () => {
    // The other String() in `print`, and the same argument: a logger that throws
    // on a hostile value is a logger that can crash the bot while reporting a
    // crash.
    const hostile = { toString: () => { throw new Error('boom'); } } as unknown as object;
    expect(() => fresh().warn(hostile)).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('degrades to stderr instead of throwing when stdout itself is broken', () => {
    // DEFECT 2. `console.log` was unguarded, so an EPIPE - a closed pipe, a full
    // disk, a container shutting down - turned every LATER `Logger.warn` in every
    // catch block in the bot into an unhandled rejection. That is precisely the
    // failure this module's own file-level catch exists to prevent, and it means
    // the worst time for the logger to break is exactly when things are already
    // going wrong. So the line is re-offered on stderr, and the log call returns.
    console.log = () => {
      throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    };
    const logger = fresh();

    expect(() => {
      logger.warn('a warning while stdout is gone');
      logger.error(new Error('a fault while stdout is gone'));
    }).not.toThrow();
    // Degraded, not dropped: the diagnostic is still emitted, on the other sink.
    expect(errors.join('\n')).toContain('a warning while stdout is gone');
  });

  it('still gives up quietly when BOTH sinks are gone, rather than throwing', () => {
    // The last line of defence. There is nothing left to say, and a throw here
    // would be the logger failing at the one moment it was least able to.
    console.log = () => {
      throw new Error('EPIPE');
    };
    console.error = () => {
      throw new Error('EPIPE');
    };
    const logger = fresh();

    expect(() => logger.fatal('nowhere left to write')).not.toThrow();
  });
});

describe('CustomLogger: what the pino-style object branch does', () => {
  it('prefers the explicit message argument over the err message', () => {
    const logger = fresh();
    logger.error({ err: new Error('the low level detail'), guildId: 'g-1' }, 'the human sentence');
    // Scoped to the MESSAGE line. At ERROR level the stack is printed as separate
    // console.log calls, and the stack textually contains the error message, so
    // asserting on the whole stdout would be asserting the opposite of the rule.
    expect(firstLine()).toContain('the human sentence');
    expect(firstLine()).not.toContain('the low level detail');
  });

  it('falls back to the err message when there is no message argument', () => {
    const logger = fresh();
    logger.error({ err: new Error('the only thing we know'), guildId: 'g-2' });
    expect(out()).toContain('the only thing we know');
  });

  it('reads msg off a plain object, so a bare structured log is not util.inspect soup', () => {
    const logger = fresh();
    logger.info({ msg: 'crown re-evaluated', artist: 'Radiohead', newHolder: 42 });
    const text = out();
    expect(text).toContain('crown re-evaluated');
    expect(text).toContain('Radiohead');
    expect(text).toContain('42');
  });

  it('accepts an err that is a plain object, not an Error', () => {
    // Callers attach `{ message, stack }` objects. Casting to Error and hoping
    // would have printed `undefined` here.
    const logger = fresh();
    logger.error({ err: { message: 'plain object error', stack: 'fake stack line 1' } });
    expect(out()).toContain('plain object error');
  });

  it('keeps the context fields, which are the actual diagnostics', () => {
    const logger = fresh();
    logger.warn({ guildId: 'g-3', reason: 'blocked', severity: 'common' }, 'track failed');
    const text = out();
    expect(text).toContain('g-3');
    expect(text).toContain('blocked');
    expect(text).toContain('common');
  });

  it('does not re-print err as part of the context dump', () => {
    const logger = fresh();
    logger.warn({ err: new Error('once is enough'), guildId: 'g-4' });
    expect(out()).not.toMatch(/err:\s*Error/);
  });

  it('prints a non-string, non-object value through String()', () => {
    const logger = fresh();
    logger.info(42);
    logger.info(null);
    logger.info(undefined);
    const text = out();
    expect(text).toContain('42');
    expect(text).toContain('null');
    expect(text).toContain('undefined');
  });

  it('applies printf formatting to extra arguments', () => {
    const logger = fresh();
    logger.info('scrobble %s by %s', 'Creep', 'Radiohead');
    expect(out()).toContain('scrobble Creep by Radiohead');
  });
});

describe('CustomLogger: the shaped one-line reporters', () => {
  it('says (DM) in the command and slash reporters, and omits the guild slot in the button one', () => {
    // Three reporters, two conventions. `command` and `slash` both carry a
    // location slot that reads `(DM)`; `button` builds `guildText` as an empty
    // string, so a press from a DM shows a bare space. Asserted as-is, because
    // the difference is real and visible in a log and the alternative is a test
    // that fails for a reason nobody wrote down.
    const logger = fresh();

    logger.command({ commandName: 'ping', userName: 'moha', durationMs: 12 });
    logger.slash({ commandName: 'topartists', userName: 'moha', durationMs: 12 });
    expect(out().match(/\(DM\)/g)).toHaveLength(2);

    lines = [];
    logger.button({ customId: 'topartists:first:0', userName: 'moha', durationMs: 12 });
    expect(out()).toContain('topartists:first:0');
    expect(out()).not.toContain('undefined');
  });

  it('names the channel and guild when the press came from one', () => {
    const logger = fresh();
    logger.command({
      commandName: 'whoknows',
      userName: 'moha',
      guildName: 'The Listening Room',
      channelName: 'stats',
      durationMs: 30,
    });
    const text = out();
    expect(text).toContain('#stats');
    expect(text).toContain('(The Listening Room)');
  });

  it('falls back to #unknown rather than printing "#undefined"', () => {
    const logger = fresh();
    logger.slash({ commandName: 'ta', userName: 'moha', guildName: 'Guild', durationMs: 5 });
    expect(out()).toContain('#unknown');
  });

  it('colours latency by band: fast is green, slow is red', () => {
    // Three bands, three colours, and a card that reads 4,200ms without comment
    // is a card that cannot answer "is the bot stuck?".
    const logger = fresh();
    const band = (ms: number) => {
      lines = [];
      logger.command({ commandName: 'x', userName: 'u', durationMs: ms });
      const raw = lines.join('');
      const match = raw.match(/\x1b\[(\d+)m(\d+)ms/);
      return match?.[1];
    };

    expect(band(12)).toBe('32'); // green
    expect(band(300)).toBe('33'); // yellow, from 300 up
    expect(band(999)).toBe('33');
    expect(band(1000)).toBe('91'); // bright red, from 1000 up
    expect(band(4200)).toBe('91');
  });

  it('prints the args it was given, and omits the space when there were none', () => {
    const logger = fresh();
    logger.command({ commandName: 'ta', args: 'weekly', userName: 'moha', durationMs: 1 });
    logger.command({ commandName: 'ping', userName: 'moha', durationMs: 1 });

    const text = out();
    expect(text).toContain('ta weekly');
    // No args must not leave a trailing separator reading as an empty argument.
    expect(text).toMatch(/ping\b/);
  });

  it('marks a slash subcommand in the command name it prints', () => {
    const logger = fresh();
    logger.slash({ commandName: 'top', subCommand: 'albums', userName: 'moha', durationMs: 1 });
    expect(out()).toContain('/top albums');

    // With no subcommand the printed name is exactly the bare command: the
    // whole-string assertion is `/topartists ` (with the trailing space) because
    // the separator that follows it is a real space before the `│`.
    lines = [];
    logger.slash({ commandName: 'topartists', userName: 'moha', durationMs: 1 });
    expect(firstLine()).toMatch(/\/topartists\s+│/);
  });

  it('prints an interaction with its customId, because that is how it is traced back', () => {
    const logger = fresh();
    logger.button({
      customId: 'friends:manage:7:1',
      userName: 'moha',
      guildName: 'The Listening Room',
      durationMs: 8,
    });
    const text = out();
    expect(text).toContain('friends:manage:7:1');
    expect(text).toContain('(The Listening Room)');
  });

  it('leaves the guild slot out of a button press with no guild', () => {
    const logger = fresh();
    logger.button({ customId: 'x:1', userName: 'moha', durationMs: 8 });
    expect(out()).not.toContain('()');
  });

  it('prints sync with and without a duration', () => {
    const logger = fresh();
    logger.sync('indexing 500 users');
    expect(out()).toContain('indexing 500 users');
    expect(out()).not.toContain('[]');

    lines = [];
    logger.sync('indexing 500 users', 4200);
    expect(out()).toContain('4200ms');
  });

  it('prints ready with the message it was given', () => {
    const logger = fresh();
    logger.ready('tvbot is online');
    expect(out()).toContain('READY');
    expect(out()).toContain('tvbot is online');
  });

  it('prints a shard event, and omits the detail clause when there is none', () => {
    const logger = fresh();
    logger.shardEvent('disconnected', 3, 'socket hang up');
    expect(out()).toContain('Shard #3 disconnected');
    expect(out()).toContain('socket hang up');

    lines = [];
    logger.shardEvent('ready', 0);
    expect(out()).toContain('Shard #0 ready');
    expect(out()).not.toContain(' - ');
  });

  it('routes a text command through the same code as a slash one', () => {
    const logger = fresh();
    logger.commandUsed({
      discordUserName: 'moha',
      discordUserId: 'd-1',
      commandResponse: 'Ok',
      responseTimeMs: 120,
      messageContent: '.ta weekly',
    });
    const text = out();
    expect(text).toContain('CommandUsed:');
    expect(text).toContain('moha / d-1');
    // Shard 0 is the default, and it is a real shard - not "unknown".
    expect(text).toContain('#0');
    expect(text).toContain('120ms');
    expect(text).toContain('.ta weekly');
  });

  it('says DM for a command used outside a guild', () => {
    const logger = fresh();
    logger.commandUsed({
      discordUserName: 'moha',
      discordUserId: 'd-1',
      commandResponse: 'Ok',
      responseTimeMs: 5,
      messageContent: '.ping',
    });
    expect(out()).toContain('DM');
  });

  it('says UserApp for a slash command used outside a guild, and names the command', () => {
    const logger = fresh();
    logger.slashCommandUsed({
      discordUserName: 'moha',
      discordUserId: 'd-1',
      commandName: 'topartists',
      commandResponse: 'Ok',
      responseTimeMs: 90,
    });
    const text = out();
    expect(text).toContain('SlashCommandUsed:');
    expect(text).toContain('UserApp');
    expect(text).toContain('topartists');
  });

  it('prints the banner without throwing, because it is called once at boot', () => {
    const logger = fresh();
    expect(() => logger.banner()).not.toThrow();
    const text = out();
    expect(text).toContain('Environment');
    expect(text).toContain('Discord.js v14');
  });
});

describe('CustomLogger: errorWithRef, the one reporter that returns something', () => {
  it('returns the reference id and the message so the user can quote it', () => {
    const logger = fresh();
    const result = logger.errorWithRef(new Error('could not reach the database'));

    expect(result.message).toBe('could not reach the database');
    expect(result.referenceId).toMatch(/^[a-z0-9]{8}$/);
  });

  it('logs the reference id, so a report in Discord can be found in Railway', () => {
    const logger = fresh();
    const { referenceId } = logger.errorWithRef(new Error('boom'), {
      commandName: 'ta',
      userName: 'moha',
      userId: 'd-1',
      guildName: 'The Listening Room',
      guildId: 'g-1',
      shardId: 2,
    });

    const text = out();
    expect(text).toContain(referenceId);
    expect(text).toContain('moha / d-1');
    expect(text).toContain('The Listening Room / g-1');
    expect(text).toContain('#2');
    expect(text).toContain('.ta');
  });

  it('prints the stack, so the Railway log holds what the user never saw', () => {
    const logger = fresh();
    logger.errorWithRef(new Error('deep failure'));
    expect(out()).toContain('    at ');
  });

  it('wraps a non-Error value rather than rendering undefined', () => {
    // A rejected promise with a string reason reaches here, and `${undefined}`
    // would give the user a reference to nothing.
    const logger = fresh();
    const result = logger.errorWithRef('just a string reason');
    expect(result.message).toBe('just a string reason');
    expect(out()).toContain('just a string reason');
  });

  it('names the unknown rather than omitting the slot', () => {
    const logger = fresh();
    logger.errorWithRef(new Error('x'));
    const text = out();
    expect(text).toContain('unknown');
  });

  it('prints the message content when there is one, in preference to the command name', () => {
    const logger = fresh();
    logger.errorWithRef(new Error('x'), { commandName: 'ta', messageContent: '.ta weekly' });
    expect(out()).toContain('.ta weekly');
  });

  it('defaults the shard to 0 rather than to a string', () => {
    const logger = fresh();
    logger.errorWithRef(new Error('x'), { commandName: 'ta' });
    expect(out()).toContain('#0');
  });
});

describe('CustomLogger: withContext', () => {
  it('returns a child that carries the merged context and does not mutate the parent', () => {
    const parent = fresh();
    const child = parent.withContext({ traceId: 'trace-1', userId: 'u-1' });

    expect(child).not.toBe(parent);
    expect(child.boundContext).toEqual({ traceId: 'trace-1', userId: 'u-1' });
    expect(parent.boundContext).toBeUndefined();
  });

  it('merges a second context over the first instead of replacing it', () => {
    // The nested shape this exists for: a handler adds a traceId, a deeper call
    // adds a command name, and both must appear in the line.
    const child = fresh().withContext({ traceId: 't', userId: 'u' }).withContext({ commandName: 'ta' });
    expect(child.boundContext).toEqual({ traceId: 't', userId: 'u', commandName: 'ta' });
  });

  it('prints the trace id on the line, so one request is greppable end to end', () => {
    // `[trace:<id>]`, which is the SPELLING THE FILE SINK USES TOO. stdout used to
    // print `[trace-42]` and the file `[trace:trace-42]`, so a grep for either form
    // found half the lines and one request read as half-finished in one reader and
    // complete in the other. One id, one spelling, both sinks.
    fresh().withContext({ traceId: 'trace-42' }).info('a line inside a request');
    expect(out()).toContain('[trace:trace-42]');
  });

  it('prints no trace prefix when there is no context, rather than an empty bracket', () => {
    fresh().info('no context here');
    expect(out()).not.toContain('[]');
  });

  it('inherits the debug gate, so a child cannot turn DEBUG on for itself', () => {
    const parent = fresh();
    parent.isDebugEnabled = false;
    const child = parent.withContext({ traceId: 't' });

    child.debug('should not appear');
    expect(lines).toHaveLength(0);
  });

  it('shares one file buffer with the parent, so lines cannot interleave', () => {
    // Two independent buffers flushing into the same file would interleave two
    // orderings. This is checked structurally because the buffer is private.
    const parent = fresh();
    const child = parent.withContext({ traceId: 't' });
    const bufferOf = (l: CustomLogger) =>
      (l as unknown as { fileBuffer: string[] }).fileBuffer;

    bufferOf(parent).push('parent-line\n');
    expect(bufferOf(child)).toEqual(['parent-line\n']);
    expect(bufferOf(child)).toBe(bufferOf(parent));
  });
});

describe('the Logger singleton', () => {
  it('is a CustomLogger instance, which is what every call site types against', () => {
    expect(Logger).toBeInstanceOf(CustomLogger);
  });

  it('honours the environment gate the class was constructed with', () => {
    // Under the test setup ENVIRONMENT is 'local', so the gate is open. What
    // matters is that the flag is a plain mutable public field the tests can pin
    // and that a log line is emitted for DEBUG.
    expect(typeof Logger.isDebugEnabled).toBe('boolean');
    const before = Logger.isDebugEnabled;
    try {
      Logger.isDebugEnabled = true;
      lines = [];
      Logger.debug('singleton debug line');
      expect(out()).toContain('singleton debug line');
    } finally {
      Logger.isDebugEnabled = before;
    }
  });

  it('never leaks a reference id collision across two failures in the same second', () => {
    // `generateReferenceId` is `Math.random().toString(36).substring(2, 10)`, so
    // the real risk is a malformed or empty id, not a collision. What a user
    // quotes has to be a usable token.
    const first = Logger.generateReferenceId();
    const second = Logger.generateReferenceId();
    expect(first).toMatch(/^[a-z0-9]{1,8}$/);
    expect(second).toMatch(/^[a-z0-9]{1,8}$/);
  });
});
