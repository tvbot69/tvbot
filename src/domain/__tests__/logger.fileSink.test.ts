import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { CustomLogger } from '../logger';

/**
 * The on-disk half of the logger: buffering, the flush protocol, and the four
 * places it is allowed to fail.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM logger.levels.test.ts
 * ---------------------------------------------------------
 * The level test covers what a reader sees on stdout. This covers the part the
 * user never sees and Railway never collects: `logs/tvbot-<date>.log`. It is
 * also the only place the buffering strategy is observable, and the strategy is
 * a real decision - `appendFileSync` per line is three blocking syscalls on the
 * event loop, which on a container filesystem is the difference between a
 * responsive bot and a visibly laggy one.
 *
 * HOW FILE LOGGING IS TURNED ON IN A TEST
 * ---------------------------------------
 * `fileLoggingEnabled` is a private instance field initialised at construction
 * from `isFileLoggingEnabled()`, which is FALSE under the test setup
 * (`NODE_ENV === 'test'`, and that check exists precisely so the suite does not
 * litter log files). So the default state - the one every other test in the repo
 * sees - is "no file logging", and the file path needs the flag raised on a
 * fresh instance. The repo's own convention for this is an `as unknown as
 * { ... }` cast onto the private, which is what §5 of the root AGENTS.md
 * prescribes for reaching privates; `as never` and `as any` are both banned.
 *
 * `fs` IS MOCKED rather than spied on, per rule 3: a real append would write
 * into the workspace. The factory spreads the real module so every OTHER fs
 * function any transitively imported module needs is untouched, and only the
 * three calls the logger makes are replaced.
 *
 * WHAT THIS FILE ALSO NOW OWNS, because it is the only place both sinks are
 * visible at once: that the file copy of a line is the SAME line stdout got -
 * same trace spelling, same stack, and (in `logger.redaction.test.ts`, which
 * mocks fs the same way) the same redaction. Three separate defects were
 * "the two copies disagree", and all three are invisible from one sink alone.
 */

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // `typeof import('fs')` has no `default` member under this tsconfig, so
  // `actual.default` is a compile error even though esModuleInterop puts the CJS
  // module object there at runtime. Spreading the namespace is the same object:
  // for a CJS builtin every named export is a property of the module itself.
  const stub = {
    ...(actual as unknown as Record<string, unknown>),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
  return { ...actual, default: stub };
});

const existsSync = vi.mocked(fs.existsSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const appendFileSync = vi.mocked(fs.appendFileSync);

/** Today, in the exact form `flushLogFile` derives from `toISOString().slice(0, 10)`. */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * A logger with file logging switched on. The private is reached through the
 * repo's own cast convention, never through `any`.
 */
const withFileLogging = (): CustomLogger => {
  const logger = new CustomLogger();
  (logger as unknown as { fileLoggingEnabled: boolean }).fileLoggingEnabled = true;
  return logger;
};

/** The lines `flushLogFile` handed to `appendFileSync`, as one string. */
const written = (): string => appendFileSync.mock.calls.map((c) => String(c[1])).join('');

/** A private read, for the buffer assertions. */
const bufferOf = (logger: CustomLogger): string[] =>
  (logger as unknown as { fileBuffer: string[] }).fileBuffer;

let lines: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

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
  existsSync.mockReset().mockReturnValue(true);
  mkdirSync.mockReset();
  appendFileSync.mockReset();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe('the default state: file logging off', () => {
  it('is off under the test environment, which is why the suite writes no log files', () => {
    // `isFileLoggingEnabled()` is `LOG_FILE !== 'false' && NODE_ENV !== 'test'`,
    // and the suite runs with NODE_ENV=test. Asserting the real gate rather than
    // a constant means a change to the gate that re-enabled file logging in CI
    // would fail here instead of quietly filling the workspace.
    const logger = new CustomLogger();
    expect((logger as unknown as { fileLoggingEnabled: boolean }).fileLoggingEnabled).toBe(false);
  });

  it('buffers nothing and writes nothing, so a disabled sink costs a single branch', () => {
    const logger = new CustomLogger();
    logger.info('a line');
    logger.error(new Error('a fault'));

    expect(bufferOf(logger)).toHaveLength(0);
    logger.flushLogFile();
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('still prints the line to stdout, because stdout is not the file copy', () => {
    // The distinction the whole module rests on: disabling the on-disk sink
    // must never disable the line Railway, Docker and every log collector read.
    const logger = new CustomLogger();
    logger.error('observable even with no file sink');
    expect(lines.join(' ')).toContain('observable even with no file sink');
  });

  it('treats flush as a no-op even with lines queued, rather than throwing', () => {
    const logger = new CustomLogger();
    expect(() => logger.flushLogFile()).not.toThrow();
    expect(appendFileSync).not.toHaveBeenCalled();
  });
});

describe('the buffered sink: what reaches the file', () => {
  it('writes one ISO-timestamped line per log call, tagged with its level', () => {
    const logger = withFileLogging();
    logger.warn('a degraded thing');
    logger.flushLogFile();

    const text = written();
    expect(text).toContain('[WARN]');
    expect(text).toContain('a degraded thing');
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps the level tag, which is the DEBUG-versus-WARN decision made checkable', () => {
    // Golden rule 10: an expected-but-notable outcome is DEBUG and a lost
    // capability is WARN. The rule is a convention at the call site, and the one
    // thing the logger owes it is a file line that says which one it was - so
    // that "the degradation was logged at all" is a grep, not a memory.
    const logger = withFileLogging();
    logger.isDebugEnabled = true;

    logger.debug('cover rung 3 returned nothing, using the placeholder');
    logger.warn('artwork cascade unavailable, holding the previous cover');
    logger.error('could not reach the database');
    logger.fatal('unhandled rejection');
    logger.info('crown re-evaluated');
    logger.flushLogFile();

    const text = written();
    expect(text).toContain('[DEBUG]');
    expect(text).toContain('[WARN]');
    expect(text).toContain('[ERROR]');
    expect(text).toContain('[FATAL]');
    expect(text).toContain('[INFO]');
  });

  it('drops a suppressed debug line entirely rather than writing an empty record', () => {
    const logger = withFileLogging();
    logger.isDebugEnabled = false;

    logger.debug('nobody asked for this');
    logger.flushLogFile();

    // Nothing was queued, so nothing was written. A file line per suppressed
    // debug call would reintroduce exactly the ~80-call-site hot-path cost the
    // opt-in gate exists to remove.
    expect(written()).not.toContain('nobody asked for this');
  });

  it('strips the colour codes, because the file is read with cat and grep', () => {
    const logger = withFileLogging();
    logger.error('a coloured line');
    logger.flushLogFile();

    expect(written()).not.toMatch(/\x1b\[/);
    expect(written()).toContain('a coloured line');
  });

  it('prefixes the trace id so one request is greppable in the file too', () => {
    // `boundContext` is a PUBLIC field, so it is set directly rather than via
    // `withContext`, and the test at the bottom of this file covers the
    // difference: `withContext` builds a brand new `CustomLogger`, so anything a
    // child needs it must be handed explicitly.
    const logger = withFileLogging();
    logger.boundContext = { traceId: 'trace-7' };
    logger.info('inside a request');
    logger.flushLogFile();

    expect(written()).toContain('[trace:trace-7]');
  });

  it('omits the trace prefix when the bound context has none', () => {
    const logger = withFileLogging();
    logger.info('no trace');
    logger.flushLogFile();

    expect(written()).not.toContain('[trace:');
  });

  it('appends the stack of a real Error, so the file holds what Discord never saw', () => {
    const logger = withFileLogging();
    logger.error(new Error('the fault'));
    logger.flushLogFile();

    expect(written()).toContain('Error: the fault');
    expect(written()).toContain('    at ');
  });

  it('records a stack for an object-shaped err the SAME WAY in both sinks', () => {
    // `err` is conventionally an Error and callers sometimes attach a plain
    // object. Both copies used to disagree: stdout read `stackLike` (any
    // `{ stack: string }`) while the file sink received `errObject`, set only for
    // `instanceof Error`, so the on-disk line carried the message and no frames.
    // One event, two answers to "was there a stack?" depending on the file you
    // opened. `print` now resolves the stack ONCE and hands the same text to both.
    const logger = withFileLogging();
    logger.error({ err: { message: 'object shaped', stack: 'frame one\nframe two' } });
    logger.flushLogFile();

    expect(lines.join('\n')).toContain('frame one');
    expect(lines.join('\n')).toContain('frame two');
    expect(written()).toContain('frame one');
    expect(written()).toContain('frame two');
  });

  it('writes no stack for a stackless value, rather than writing "undefined"', () => {
    const logger = withFileLogging();
    logger.error('just a string');
    logger.flushLogFile();

    expect(written()).not.toContain('undefined');
  });

  it('names today\'s file, so a reader knows which day they are looking at', () => {
    const logger = withFileLogging();
    logger.info('a line');
    logger.flushLogFile();

    expect(String(appendFileSync.mock.calls[0]?.[0])).toContain(`tvbot-${today()}.log`);
  });
});

describe('the buffered sink: the flush protocol', () => {
  it('buffers rather than writing per line, and writes nothing until asked', () => {
    // The whole reason the buffer exists. Three lines and still zero syscalls.
    const logger = withFileLogging();
    logger.info('one');
    logger.info('two');
    logger.info('three');

    expect(bufferOf(logger)).toHaveLength(3);
    expect(appendFileSync).not.toHaveBeenCalled();

    logger.flushLogFile();
    expect(appendFileSync).toHaveBeenCalledTimes(1);
  });

  it('drains the buffer, so a second flush does not rewrite the same lines', () => {
    const logger = withFileLogging();
    logger.info('first');
    logger.flushLogFile();
    logger.flushLogFile();

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(written()).toContain('first');
    expect(written().match(/first/g)).toHaveLength(1);
  });

  it('batches every queued line into one append, not one per line', () => {
    const logger = withFileLogging();
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    logger.flushLogFile();

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(written().split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('writes to UTF-8, because the names on a who-knows card are not ASCII', () => {
    const logger = withFileLogging();
    logger.info('مس — EsDeeKid');
    logger.flushLogFile();

    expect(appendFileSync.mock.calls[0]?.[2]).toBe('utf8');
    expect(written()).toContain('مس');
  });

  it('flushes by itself once the buffer reaches its ceiling', () => {
    // The backstop for a bot that logs more than a user ever presses a button:
    // without it, a long-lived process with no explicit flush would grow the
    // array without bound inside a 384MB heap.
    const logger = withFileLogging();
    for (let i = 0; i < 200; i++) logger.info(`line ${i}`);

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(written()).toContain('line 199');
    expect(written()).not.toContain('line 200\n');
  });

  it('creates the log directory the first time, and checks for it exactly once', () => {
    existsSync.mockReturnValue(false);
    const logger = withFileLogging();
    logger.info('a');
    logger.flushLogFile();
    logger.info('b');
    logger.flushLogFile();

    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(existsSync).toHaveBeenCalledTimes(1);
    expect(appendFileSync).toHaveBeenCalledTimes(2);
  });

  it('asks for a recursive directory creation, because the parent may be missing too', () => {
    existsSync.mockReturnValue(false);
    const logger = withFileLogging();
    logger.info('a');
    logger.flushLogFile();

    expect(mkdirSync.mock.calls[0]?.[1]).toEqual({ recursive: true });
  });

  it('does not create the directory when it already exists', () => {
    existsSync.mockReturnValue(true);
    const logger = withFileLogging();
    logger.info('a');
    logger.flushLogFile();

    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('a queued-but-unflushed line never reaches disk', () => {
    // Asserted because the failure it guards against is invisible: a process
    // that ends between the buffer write and the flush loses the tail, and
    // nobody would see it.
    const logger = withFileLogging();
    logger.error('queued only');
    expect(appendFileSync).not.toHaveBeenCalled();
  });
});

describe('the buffered sink: the four places it fails, and what each costs', () => {
  it('never throws out of a log call when the filesystem refuses', () => {
    // The load-bearing assertion. A read-only container filesystem and a full
    // disk are both realistic and both recur for the process lifetime, and this
    // file is reached from inside catch blocks all over the bot. Throwing here
    // would replace a reported fault with an unhandled rejection.
    appendFileSync.mockImplementation(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });
    const logger = withFileLogging();

    expect(() => {
      logger.info('a');
      logger.flushLogFile();
      logger.warn('b');
      logger.flushLogFile();
      logger.fatal('c');
      logger.flushLogFile();
    }).not.toThrow();
  });

  it('keeps the stdout line, because stdout is written first and is never the file', () => {
    appendFileSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const logger = withFileLogging();

    logger.error('this line still reached the log collector');
    logger.flushLogFile();

    expect(lines.join(' ')).toContain('this line still reached the log collector');
  });

  it('says so on stderr, naming the sink, so the gap is visible in the platform log', () => {
    appendFileSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const logger = withFileLogging();
    logger.info('a');
    logger.flushLogFile();

    expect(errors.join('\n')).toContain('file logging failed');
    expect(errors.join('\n')).toContain('ENOSPC');
    // Bare `console.error`, not `this.error`: the latter reaches the file sink
    // and would recurse straight back in on a disk that is still broken.
    expect(errors.join('\n')).toContain('stdout unaffected');
  });

  it('drops the failed lines instead of putting them back, which is the lesser evil', () => {
    // Refilling the buffer on a persistently failing disk turns a logging
    // problem into an OOM inside a process capped at 384MB - strictly worse than
    // a missing log file, and the stdout copy is already out.
    appendFileSync.mockImplementation(() => {
      throw new Error('EROFS');
    });
    const logger = withFileLogging();
    logger.info('a');
    logger.info('b');
    logger.flushLogFile();

    expect(bufferOf(logger)).toHaveLength(0);
  });

  it('recovers on the next flush once the disk is writable again', () => {
    appendFileSync.mockImplementationOnce(() => {
      throw new Error('EROFS');
    });
    const logger = withFileLogging();
    logger.info('lost to the disk');
    logger.flushLogFile();

    logger.info('kept');
    logger.flushLogFile();

    // Scoped to the calls that DID land. `mock.calls` records the argument of a
    // call whose implementation threw, so asserting against every recorded call
    // would find the dropped line in an append that never happened.
    const landed = appendFileSync.mock.results
      .map((r, i) => (r.type === 'return' ? String(appendFileSync.mock.calls[i]?.[1]) : ''))
      .join('');
    expect(landed).toContain('kept');
    expect(landed).not.toContain('lost to the disk');
  });

  it('reports a non-Error rejection value, because a disk failure is not always an Error', () => {
    appendFileSync.mockImplementation(() => {
      throw 'a bare string from a native binding';
    });
    const logger = withFileLogging();
    logger.info('a');

    expect(() => logger.flushLogFile()).not.toThrow();
    expect(errors.join('\n')).toContain('a bare string from a native binding');
  });

  it('survives the directory creation failing before the append is even attempted', () => {
    existsSync.mockReturnValue(false);
    mkdirSync.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    const logger = withFileLogging();
    logger.info('a');

    expect(() => logger.flushLogFile()).not.toThrow();
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('EROFS');
  });

  it('does not start a flush timer at all when file logging is off', () => {
    // The timer is `unref`'d, so it cannot hold the process open, but an
    // unref'd interval per suppressed call is still real work on the hot path.
    const logger = new CustomLogger();
    logger.info('a');
    logger.info('b');
    expect((logger as unknown as { flushTimer?: NodeJS.Timeout }).flushTimer).toBeUndefined();
  });
});

describe('withContext and the file sink: the child inherits the sink', () => {
  /*
   * FIXED, and pinned by the test below.
   *
   * `withContext` used to copy FOUR fields across - `isDebugEnabled`,
   * `boundContext`, `fileBuffer`, `logDirReady` - and NOT `fileLoggingEnabled`.
   * The child is a fresh `CustomLogger` that re-read that flag from the
   * environment, so a child's `writeLogToFile` returned at its first line
   * whenever the environment said the sink was off, and every line it emitted was
   * absent from `logs/tvbot-<date>.log` while the parent's landed in the same
   * shared buffer, in order, as if nothing were wrong.
   *
   * In PRODUCTION the environment has the sink on, so nothing was lost - which is
   * exactly why it survived. It bites the moment anyone sets `LOG_FILE=false` to
   * test something, and the file is the thing being read at that moment.
   * `contextModel.ts:37` is the only production caller.
   */
  it('writes the CHILD\'s line to the file, because it inherits the parent\'s flag', () => {
    // This is the test the defect was found with: it was written, it failed, and
    // it had to be un-written because the behaviour was wrong. The behaviour is
    // now right, so the test is back - and it is the one that would catch the flag
    // being dropped again.
    const parent = withFileLogging();
    const child = parent.withContext({ traceId: 'trace-9' });

    child.info('from the child');
    parent.info('from the parent');
    parent.flushLogFile();

    const text = written();
    expect(text).toContain('from the child');
    expect(text).toContain('from the parent');
    // The child's line carries the trace prefix in the FILE too, so one request
    // is greppable in one place rather than two.
    expect(text).toContain('[trace:trace-9] from the child');
  });

  it('inherits the flag, structurally, because the value is what is load-bearing', () => {
    // Asserted on the private as well as on the behaviour above: the flag is the
    // one piece of state `withContext` has to carry, and a test that only watched
    // the output would still pass if the child wrote through some other route.
    const parent = withFileLogging();
    const child = parent.withContext({ traceId: 't' });
    expect((child as unknown as { fileLoggingEnabled: boolean }).fileLoggingEnabled).toBe(true);
  });

  it('does not switch the file sink ON for a child of a logger that has it off', () => {
    // The other direction, because a fix that hard-coded `true` would pass the
    // test above. The parent's flag is the whole contract, in both directions.
    const parent = new CustomLogger();
    const child = parent.withContext({ traceId: 't' });

    child.info('nothing should reach disk');
    expect((child as unknown as { fileLoggingEnabled: boolean }).fileLoggingEnabled).toBe(false);
    expect(bufferOf(child)).toHaveLength(0);
  });

  it('gives the child its own trace prefix on the line it prints', () => {
    const parent = withFileLogging();
    const child = parent.withContext({ traceId: 'trace-9' });

    child.info('from the child');
    parent.info('from the parent');

    // One spelling for both sinks, so this and the assertion above are the same
    // string. They used to be `[trace-9]` here and `[trace:trace-9]` on disk.
    expect(lines[0]).toContain('[trace:trace-9]');
    // The parent's line has no trace, which is the visible difference between
    // the two and the reason a child is worth having at all.
    expect(lines[1]).not.toContain('trace-9');
  });

  it('writes the parent\'s own line to the file, so the sink is demonstrably live', () => {
    // The half that always worked, pinned so the tests above are provably about
    // the CHILD and not about a dead sink.
    const parent = withFileLogging();
    parent.info('from the parent');
    parent.flushLogFile();

    expect(written()).toContain('from the parent');
  });

  it('queues child lines into the very same buffer as the parent', () => {
    // Structural: `child.fileBuffer = this.fileBuffer` is a reference assignment,
    // not a copy, which is what keeps two flushes from interleaving.
    const parent = withFileLogging();
    const child = parent.withContext({ traceId: 'trace-9' });

    expect(bufferOf(child)).toBe(bufferOf(parent));
    expect((child as unknown as { flushTimer?: NodeJS.Timeout }).flushTimer).toBeUndefined();
  });
});
