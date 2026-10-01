import util from 'util';
import type { InspectOptions } from 'util';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { displayNodeEnv, isDebugLogging, isFileLoggingEnabled } from '@config/runtimeEnv';

export interface LogContext {
  traceId?: string;
  userId?: string;
  guildId?: string;
  commandName?: string;
  shardId?: number;
}

// Enable UTF-8 encoding for Windows terminals so Arabic, emojis, and symbols render cleanly
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // CORRECT AS IS, and it is the only catch in this file with no logging
    // implication whatsoever: this runs at MODULE LOAD, before a single logger
    // exists, and it only sets the Windows console codepage so emoji and Arabic
    // render in a local terminal. A failure means the terminal shows mojibake in
    // a developer's own shell - it cannot affect a log line, because no log line
    // exists yet and stdout on a deployed container is not a Windows console.
  }
}

// ANSI terminal color codes
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright foreground
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',
};

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${ansi.dim}[${h}:${m}:${s}]${ansi.reset}`;
}

function formatLatency(ms: number): string {
  if (ms < 300) return `${ansi.green}${ms}ms${ansi.reset}`;
  if (ms < 1000) return `${ansi.yellow}${ms}ms${ansi.reset}`;
  return `${ansi.brightRed}${ms}ms${ansi.reset}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** The single word that replaces every credential this module finds. */
const REDACTED = '[REDACTED]';

/**
 * Key names whose VALUE is a credential, matched against a NORMALISED key
 * (lowercased, every non-alphanumeric character removed), so `api_key`,
 * `apiKey`, `API-KEY` and `api key` are one entry rather than four.
 *
 * `key` on its own is deliberately NOT here, and neither is it a suffix. A bare
 * `key` is a dictionary word in this codebase: cache keys, idempotency keys,
 * Discord component keys, Puppeteer screenshots. Scrubbing those would blank
 * the structured logs that carry most of the diagnosis, and a redactor that
 * eats the evidence is one nobody can debug around. The compounds that really
 * are credentials (`apiKey`, `privateKey`, `encryptionKey`-shaped names) are
 * listed explicitly, which is a deliberate choice to miss a name nobody has
 * written yet rather than to blind half the bot.
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'auth',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bottoken',
  'apikey',
  'apisecret',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'privatekey',
  'credential',
  'credentials',
  'sessionkey',
  'signature',
  'xapikey',
]);

/**
 * Suffixes, so a vendor-prefixed name (`spotifyAccessToken`, `discordToken`,
 * `lastfmApiSecret`) is caught without enumerating every vendor.
 */
const SECRET_KEY_SUFFIXES: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'privatekey',
  'sessionkey',
];

/** Normalise a key for the denylist: lowercase, letters and digits only. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a property name says "the value here is a credential". */
export function isSecretKey(key: string): boolean {
  const norm = normaliseKey(key);
  if (!norm) return false;
  if (SECRET_KEY_NAMES.has(norm)) return true;
  // `tokenCount` is a number a reader needs; `discordToken` is a credential. The
  // suffix has to actually reach the end of the name for the second to match.
  return SECRET_KEY_SUFFIXES.some((suffix) => norm.endsWith(suffix) && norm.length > suffix.length);
}

/**
 * Value-shape rules for TEXT, because most callers log a credential inside a
 * sentence, a URL or a vendor message rather than under a tidy key. Ordered:
 * the scheme word is consumed with its credential, and the long shapes go
 * before the general `key=value` rule so a JWT is not left half-scrubbed.
 *
 * WHAT THIS DELIBERATELY DOES NOT SCRUB, and why:
 *   - A bare high-entropy hex or base64 blob. A 32-hex string is a Last.fm API
 *     key to one caller and a content hash to the next, and the difference is
 *     invisible in the log. A heuristic that cannot tell them apart eats the
 *     hashes, which are evidence.
 *   - Numeric ids, ISO timestamps, durations, scrobble counts, user ids, guild
 *     ids and Last.fm usernames. None of them is a credential and every one of
 *     them is something a reader needs.
 *   - A URL that carries no credential. `https://host/path?a=1` stays legible;
 *     only a `user:password@` or a credential-shaped query parameter is cut.
 *   - Env var NAMES. `LASTFM_API_KEY is unset` is the single most useful line a
 *     boot failure can print, and the name is not the value.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer <token>` and its cousins. First, so the scheme word
  // and the credential behind it go as one.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // JWT: three base64url segments, header always starts `eyJ`.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Vendor-shaped keys. The prefix survives so the reader still knows what leaked.
  [/\b(sk-|ghp_|gho_|ghu_|ghs_|xox[baprs]-|github_pat_)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // Discord bot token: three segments with a long tail. A JWT is already gone by
  // here, so this cannot eat one.
  [/\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{5,7}\.[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  // `postgres://user:password@host`, `redis://:password@host`. The user stays,
  // because "who" is a diagnostic; only the password is a credential.
  [/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]{1,64}:)([^/\s@]{1,128}@)/g, `$1$2${REDACTED}@`],
  // `?api_key=`, `api_sig=`, `"client_secret": "`, `token=`, `Authorization:`.
  // The separator slot allows a quote on either side because a JSON body
  // embeds the key in quotes (`{"client_secret":"..."}`) and that shape is
  // exactly what a vendor error message carries. The four-character floor is
  // what keeps prose out: `Bearer` above was already consumed with its
  // credential, so anything left that short is more likely a word worth seeing.
  [
    /\b(api[_-]?key|api[_-]?secret|api[_-]?sig|apikey|apisecret|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?key|token|password|passwd|passphrase|pwd|auth|authorization|cookie)(["']?\s*[:=]\s*)(?!Bearer\b|Basic\b|Token\b)(["']?)(?!\[REDACTED\])([^\s"',;&)}\]]{4,})\3/gi,
    `$1$2$3${REDACTED}$3`,
  ],
];

/**
 * Scrub every value-shaped credential out of a string. Pure, allocation-light
 * enough for the hot path, and total: it cannot throw for any string input.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * How deep the recursive walk goes before it stops descending.
 *
 * `util.inspect` already renders at depth 3, so a deeper walk buys nothing a
 * reader can see while making a hostile value (`{a:{a:{a:...}}}`) expensive.
 * Beyond the cap a value is NAMED rather than rendered, which is honest: a
 * redactor that silently returns a partial object is a redactor that invents
 * evidence.
 */
const MAX_REDACT_DEPTH = 4;

/** `String(value)`, guarded: a value whose `toString` throws costs itself only. */
function describeSafely(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[value could not be stringified]';
  }
}

/**
 * `util.inspect` behind one name, so the depth and colour options this module
 * uses are stated once instead of at two call sites.
 *
 * Deliberately NOT wrapped in its own try/catch. Measured: `util.inspect` is
 * tolerant of everything thrown at it - a getter that throws renders as
 * `[Getter]`, and even a Proxy whose `ownKeys` traps renders its target - so a
 * catch here would be a guard with no reachable failure, which is a guard nobody
 * has verified. If it ever DOES throw, the net that catches it is the tested one
 * in `print`, which keeps the line and says the value could not be rendered.
 */
function inspectValue(value: unknown, options: InspectOptions): string {
  return util.inspect(value, options);
}

/**
 * A copy of `err` with a scrubbed message and stack, or the ORIGINAL when
 * nothing matched.
 *
 * A vendor message is a real leak path, not a hypothetical one: a Last.fm
 * 401 arrives as `... 2.0/?method=user.getInfo&api_key=...&api_sig=...`, and
 * the stack of the fetch that made it carries the same URL. Cloning only on a
 * match means an ordinary error keeps its identity, its prototype and its own
 * custom fields; the copy exists solely so a scrubbed credential cannot ride
 * along inside `err.stack`.
 */
function redactError(err: Error): Error {
  const message = redactSecrets(err.message);
  const stack = typeof err.stack === 'string' ? redactSecrets(err.stack) : err.stack;
  if (message === err.message && stack === err.stack) return err;
  const clone = new Error(message);
  clone.name = err.name;
  clone.stack = stack;
  return clone;
}

/**
 * Recursively scrub a value for logging: key names first (a credential under
 * `access_token` is a credential whatever it looks like), then value shapes for
 * every string that survives.
 *
 * NEVER THROWS. That is the whole design constraint, and it outranks being
 * thorough: this is reached from inside catch blocks across the bot, and a
 * redactor that crashes turns a reported fault into a crash on the reporting
 * path. Three defences, in order of how much they preserve:
 *
 *   1. a depth cap, so a self-referential or absurdly nested value costs a
 *      fixed amount of work;
 *   2. a `WeakSet` of visited objects, so a cycle terminates;
 *   3. a per-property try/catch, because `Object.keys` does not invoke a getter
 *      but READING one does, and a throwing getter is a thing a vendor library
 *      can hand you.
 *
 * If all of that somehow fails, the caller logs the original value. Losing the
 * line is strictly worse than logging it unscrubbed: the first is a bot with no
 * diagnosis, the second is a bot with a diagnosis someone has to look twice at.
 */
function redactForLog(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return redactError(value);
  if (value instanceof Date || value instanceof RegExp || value instanceof Buffer) return value;
  if (depth >= MAX_REDACT_DEPTH) return '[value nested too deeply to print]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactForLog(entry, depth + 1, seen));
    }
    if (value instanceof Set) {
      return new Set(Array.from(value, (entry) => redactForLog(entry, depth + 1, seen)));
    }
    if (value instanceof Map) {
      // A credential is as likely to be a map KEY as a map value: `new Map([[
      // ['access_token', 'abc']])` is the shape a credential arrives in.
      const scrubbed = new Map<unknown, unknown>();
      for (const [key, entry] of value) {
        scrubbed.set(redactForLog(key, depth + 1, seen), redactForLog(entry, depth + 1, seen));
      }
      return scrubbed;
    }
    const source = value as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(source)) {
      let entry: unknown;
      try {
        entry = source[key];
      } catch {
        // A getter threw. Naming the key is more useful than dropping it, and it
        // is a fact about the value rather than a guess about it.
        entry = '[property could not be read]';
        changed = true;
      }
      const next = isSecretKey(key) ? REDACTED : redactForLog(entry, depth + 1, seen);
      if (next !== entry) changed = true;
      scrubbed[key] = next;
    }
    // Identity when nothing matched, so an ordinary object keeps its prototype
    // and `util.inspect` keeps printing its class name.
    return changed ? scrubbed : value;
  } catch {
    return value;
  } finally {
    seen.delete(value);
  }
}

/**
 * Public entry point: the value to hand to `util.inspect` when logging.
 *
 * There is no try/catch here, and that is deliberate rather than an oversight.
 * `redactForLog` is already total - it guards each property read, wraps its body,
 * and the only operations left are `WeakSet` bookkeeping and `instanceof` - so a
 * catch here could only ever be reached by a bug in code five lines above it. A
 * guard nobody can exercise is a guard nobody has verified, and this file's
 * standard is that an untested safety net is worse than none. The real last net
 * is the one that IS tested: `print` wraps its whole compose-and-redact step, so
 * a value that defeats the walk costs the line's content and not the log call.
 */
export function redactForLogValue(value: unknown): unknown {
  return redactForLog(value, 0, new WeakSet<object>());
}

function padBoxLine(content: string, innerWidth: number = 58): string {
  const visibleLen = stripAnsi(content).length;
  const padding = Math.max(0, innerWidth - visibleLen);
  return `  ${ansi.brightCyan}│${ansi.reset} ${content}${' '.repeat(padding)} ${ansi.brightCyan}│${ansi.reset}`;
}

/**
 * Anything a log line can carry: a message, an Error, or a structured object.
 *
 * This was 'any' before, which meant the logger accepted anything AND told the
 * compiler nothing. Typing it makes every log call site in the bot checked.
 */
export type Loggable = string | number | boolean | bigint | symbol | null | undefined | Error | object;

export class CustomLogger {
  /**
   * Debug logging is opt-in. It used to include `NODE_ENV !== 'production'`,
   * but nothing sets NODE_ENV in the deploy env (only ENVIRONMENT), so DEBUG
   * was ON in production: every one of the ~80 debug call sites then paid
   * util.format + util.inspect + a synchronous disk append, on the hot path,
   * for logs nobody reads. Gate on the key the rest of the app actually uses.
   */
  public isDebugEnabled = isDebugLogging();
  public boundContext?: LogContext;
  private logDir = path.resolve(process.cwd(), 'logs');
  private fileLoggingEnabled = isFileLoggingEnabled();
  /**
   * File writes are buffered and flushed on an interval. `appendFileSync` per
   * line is 3+ blocking syscalls (existsSync/mkdirSync/append) on the event
   * loop — on a container filesystem that is the difference between a
   * responsive bot and a visibly laggy one under load. stdout still prints
   * immediately, which is what the platform collects anyway.
   */
  private fileBuffer: string[] = [];
  private logDirReady = false;
  private static readonly FLUSH_INTERVAL_MS = 2000;
  private static readonly FLUSH_MAX_LINES = 200;
  private flushTimer?: NodeJS.Timeout;

  public withContext(context: LogContext): CustomLogger {
    const child = new CustomLogger();
    child.isDebugEnabled = this.isDebugEnabled;
    child.boundContext = { ...(this.boundContext ?? {}), ...context };
    // Share the parent's buffer: a child logger must not interleave a
    // separate flush into the middle of the parent's ordering.
    child.fileBuffer = this.fileBuffer;
    child.logDirReady = this.logDirReady;
    // AND the file-sink flag, which was the one field left out. It is a private
    // read once from the environment at construction, so a fresh child re-derives
    // it - and a child built while `LOG_FILE=false` had every one of its lines
    // silently dropped on the first line of `writeLogToFile`, while the parent's
    // landed, in the same buffer, in order. Nothing was lost in production (the
    // environment has the sink on) and everything was lost the moment anyone
    // switched the sink off to test something, which is exactly when the file
    // is the thing being read. `contextModel.ts:37` is the only production
    // caller, so this is the whole blast radius.
    child.fileLoggingEnabled = this.fileLoggingEnabled;
    return child;
  }

  /**
   * One spelling of the trace id, for both sinks.
   *
   * They used to disagree - stdout printed `[trace-9]` and the file printed
   * `[trace:trace-9]` - so grepping for either form found half the lines and a
   * request looked half-finished in one reader and complete in the other. The
   * file form wins because it is the one that was already prefixed with
   * `[trace:` and a bare `[trace-9]` inside a line of prose is easy to miss.
   */
  private tracePrefix(): string {
    return this.boundContext?.traceId ? `[trace:${this.boundContext.traceId}] ` : '';
  }

  /**
   * The ONE place a line reaches stdout, and it cannot throw.
   *
   * `console.log` is unguarded everywhere else in the ecosystem, which is fine
   * everywhere else. Here it is not: an EPIPE (a closed pipe, a full disk, a
   * container shutting down) throws out of `console.log`, and because this
   * module is reached from inside the catch block of ~every failure path in the
   * bot, one broken stdout turns each of those `Logger.warn` calls into an
   * unhandled rejection. The worst possible time for the logger to break is
   * exactly when things are already going wrong.
   *
   * So: try stdout, and on failure fall back to stderr with the line still
   * attached, then give up silently if stderr is broken too. The cost is the
   * colour separation of stdout vs stderr for a line printed during a stdout
   * failure - which nobody is reading anyway.
   */
  private emit(line: string): void {
    // Redact HERE as well as in `print`, and the duplication is the point: every
    // stdout line in this class goes through this method, so no reporter added
    // later can become the one hole in the file's no-credentials guarantee. It is
    // idempotent, so `print` re-redacting for the file sink costs a scan and
    // changes nothing.
    //
    // No try/catch around `redactSecrets`, for the reason given on
    // `redactForLogValue`: it is total over string input - `String.replace` with
    // these patterns cannot throw for any input, and a pattern that COULD is a
    // module-load failure rather than a logging failure. The catch that matters
    // is the one below.
    const safe = redactSecrets(line);
    try {
      console.log(safe);
    } catch {
      try {
        console.error(safe);
      } catch {
        // Both sinks gone. There is nothing left to say and something else to do.
      }
    }
  }

  private writeLogToFile(level: string, message: string, stack?: string): void {
    if (!this.fileLoggingEnabled) return;
    try {
      const now = new Date();
      const cleanMsg = stripAnsi(message);
      let logLine = `[${now.toISOString()}] [${level}] ${this.tracePrefix()}${cleanMsg}\n`;
      if (stack) {
        logLine += `${stack}\n`;
      }
      this.fileBuffer.push(logLine);
      if (this.fileBuffer.length >= CustomLogger.FLUSH_MAX_LINES) {
        this.flushLogFile();
        return;
      }
      if (!this.flushTimer) {
        this.flushTimer = setInterval(() => this.flushLogFile(), CustomLogger.FLUSH_INTERVAL_MS);
        this.flushTimer.unref?.();
      }
    } catch {
      // CORRECT AS IS, and the invariant worth writing down is the ORDER in
      // `print`, not this catch. `print` writes `console.log` FIRST and only
      // then calls `writeLogToFile`, so by the time anything can fail here the
      // line has already gone to stdout - which is what Railway, Docker and
      // every platform log collector read. A filesystem failure can cost the
      // on-disk COPY and never the observable one.
      //
      // So the question "can a logging failure drop the line?" is answered by
      // `print`, and the answer is no. That is why the catch stays: throwing out
      // of a logger replaces a reported fault with an unhandled rejection,
      // which loses strictly more than the file copy ever was. If `print` is
      // ever reordered to write the file first, THIS comment becomes false and
      // the whole errorFeed path inherits the lie.
    }
  }

  /** Drains the buffer to today's log file. Never throws. */
  public flushLogFile(): void {
    if (!this.fileLoggingEnabled || this.fileBuffer.length === 0) return;
    const lines = this.fileBuffer;
    this.fileBuffer = [];
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      if (!this.logDirReady) {
        if (!fs.existsSync(this.logDir)) {
          fs.mkdirSync(this.logDir, { recursive: true });
        }
        this.logDirReady = true;
      }
      const now = new Date();
      const logFile = path.join(this.logDir, `tvbot-${now.toISOString().slice(0, 10)}.log`);
      fs.appendFileSync(logFile, lines.join(''), 'utf8');
    } catch (err) {
      // CORRECT AS IS, and the same invariant as `writeLogToFile` above: every
      // line in `lines` was already written to stdout by `print` before it was
      // ever buffered, so this only ever costs the on-disk copy. Read-only
      // container filesystems and a full disk are the realistic causes, and both
      // recur for the whole process lifetime.
      //
      // The lines are deliberately NOT put back on the buffer. A persistently
      // failing filesystem would then grow `fileBuffer` without bound inside a
      // process capped at `--max-old-space-size=384`, turning a logging problem
      // into an OOM that takes the bot down - strictly worse than a missing log
      // file. Dropping them is the lesser evil and the stdout copy is intact.
      //
      // This runs with a bare `console.error` rather than `this.error`, because
      // `this.error` reaches `writeLogToFile` and would recurse straight back
      // into this function on a disk that is still broken.
      console.error(`[logger] file logging failed, stdout unaffected: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  public banner(): void {
    const innerWidth = 58;
    const top = `  ${ansi.brightCyan}╭${'─'.repeat(innerWidth + 2)}╮${ansi.reset}`;
    const bot = `  ${ansi.brightCyan}╰${'─'.repeat(innerWidth + 2)}╯${ansi.reset}`;

    const lines = [
      '',
      top,
      padBoxLine('', innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}████████╗██╗   ██╗██████╗  ██████╗ ████████╗${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}╚══██╔══╝██║   ██║██╔══██╗██╔═══██╗╚══██╔══╝${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ██║   ██║   ██║██████╔╝██║   ██║   ██║     ${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ██║   ╚██╗ ██╔╝██╔══██╗██║   ██║   ██║     ${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ██║    ╚████╔╝ ██████╔╝╚██████╔╝   ██║     ${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ╚═╝     ╚═══╝  ╚═════╝  ╚═════╝    ╚═╝   ${ansi.brightMagenta}v0.1.0${ansi.reset}`, innerWidth),
      padBoxLine('', innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Environment${ansi.gray} : ${ansi.green}${displayNodeEnv()}${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Node.js${ansi.gray}     : ${ansi.yellow}${process.version}${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Framework${ansi.gray}   : ${ansi.brightBlue}Discord.js v14 + Prisma + PostgreSQL${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Audio${ansi.gray}       : ${ansi.magenta}Moonlink + Essentia DSP${ansi.reset}`, innerWidth),
      padBoxLine('', innerWidth),
      bot,
      '',
    ];

    this.emit(lines.join('\n'));
  }

  public info(msgOrObj: Loggable, ...args: unknown[]): void {
    this.print('INFO', `${ansi.brightCyan}${ansi.bold} INFO  ${ansi.reset}`, ansi.brightWhite, msgOrObj, args);
  }

  public warn(msgOrObj: Loggable, ...args: unknown[]): void {
    this.print('WARN', `${ansi.bgYellow}${ansi.black}${ansi.bold} WARN  ${ansi.reset}`, ansi.brightYellow, msgOrObj, args);
  }

  public error(msgOrObj: Loggable, ...args: unknown[]): void {
    this.print('ERROR', `${ansi.bgRed}${ansi.brightWhite}${ansi.bold} ERROR ${ansi.reset}`, ansi.brightRed, msgOrObj, args);
  }

  public fatal(msgOrObj: Loggable, ...args: unknown[]): void {
    this.print('FATAL', `${ansi.bgRed}${ansi.brightWhite}${ansi.bold} FATAL ${ansi.reset}`, ansi.brightRed, msgOrObj, args);
  }

  public debug(msgOrObj: Loggable, ...args: unknown[]): void {
    if (!this.isDebugEnabled) return;
    this.print('DEBUG', `${ansi.gray}${ansi.bold} DEBUG ${ansi.reset}`, ansi.gray, msgOrObj, args);
  }

  public ready(message: string): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgGreen}${ansi.black}${ansi.bold} READY ${ansi.reset}`;
    this.emit(`${time} ${tag} ${ansi.brightGreen}${ansi.bold}${message}${ansi.reset}`);
  }

  public command(info: {
    commandName: string;
    args?: string;
    userName: string;
    guildName?: string | null;
    channelName?: string | null;
    durationMs: number;
    success?: boolean;
  }): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgCyan}${ansi.black}${ansi.bold}  CMD  ${ansi.reset}`;
    const cmdText = `${ansi.brightGreen}${ansi.bold}.${info.commandName}${ansi.reset}${info.args ? ` ${ansi.cyan}${info.args}${ansi.reset}` : ''}`;
    const userText = `${ansi.dim}by${ansi.reset} ${ansi.brightWhite}${info.userName}${ansi.reset}`;
    const locationText = info.guildName
      ? `${ansi.dim}in${ansi.reset} ${ansi.magenta}#${info.channelName ?? 'unknown'}${ansi.reset} ${ansi.dim}(${info.guildName})${ansi.reset}`
      : `${ansi.dim}(DM)${ansi.reset}`;
    const latency = formatLatency(info.durationMs);

    this.emit(`${time} ${tag} ${cmdText} ${ansi.dim}│${ansi.reset} ${userText} ${locationText} ${ansi.dim}[${latency}${ansi.dim}]${ansi.reset}`);
  }

  public slash(info: {
    commandName: string;
    subCommand?: string | null;
    options?: string;
    userName: string;
    guildName?: string | null;
    channelName?: string | null;
    durationMs: number;
  }): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgBlue}${ansi.brightWhite}${ansi.bold} SLASH ${ansi.reset}`;
    const fullCmd = info.subCommand ? `/${info.commandName} ${info.subCommand}` : `/${info.commandName}`;
    const cmdText = `${ansi.brightCyan}${ansi.bold}${fullCmd}${ansi.reset}${info.options ? ` ${ansi.cyan}${info.options}${ansi.reset}` : ''}`;
    const userText = `${ansi.dim}by${ansi.reset} ${ansi.brightWhite}${info.userName}${ansi.reset}`;
    const locationText = info.guildName
      ? `${ansi.dim}in${ansi.reset} ${ansi.magenta}#${info.channelName ?? 'unknown'}${ansi.reset} ${ansi.dim}(${info.guildName})${ansi.reset}`
      : `${ansi.dim}(DM)${ansi.reset}`;
    const latency = formatLatency(info.durationMs);

    this.emit(`${time} ${tag} ${cmdText} ${ansi.dim}│${ansi.reset} ${userText} ${locationText} ${ansi.dim}[${latency}${ansi.dim}]${ansi.reset}`);
  }

  public button(info: {
    customId: string;
    userName: string;
    guildName?: string | null;
    durationMs: number;
  }): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgMagenta}${ansi.brightWhite}${ansi.bold} INTER ${ansi.reset}`;
    const idText = `${ansi.brightMagenta}${info.customId}${ansi.reset}`;
    const userText = `${ansi.dim}by${ansi.reset} ${ansi.brightWhite}${info.userName}${ansi.reset}`;
    const guildText = info.guildName ? `${ansi.dim}(${info.guildName})${ansi.reset}` : '';
    const latency = formatLatency(info.durationMs);

    this.emit(`${time} ${tag} ${idText} ${ansi.dim}│${ansi.reset} ${userText} ${guildText} ${ansi.dim}[${latency}${ansi.dim}]${ansi.reset}`);
  }

  public sync(message: string, durationMs?: number): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgYellow}${ansi.black}${ansi.bold} SYNC  ${ansi.reset}`;
    const latencyText = durationMs !== undefined ? ` ${ansi.dim}[${formatLatency(durationMs)}${ansi.dim}]${ansi.reset}` : '';
    this.emit(`${time} ${tag} ${ansi.yellow}${message}${ansi.reset}${latencyText}`);
  }

  public generateReferenceId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  public commandUsed(info: {
    discordUserName: string;
    discordUserId: string;
    guildName?: string | null;
    guildId?: string | null;
    shardId?: number;
    commandResponse: string;
    responseTimeMs: number;
    messageContent: string;
  }): void {
    const shard = info.shardId ?? 0;
    const guildText = info.guildName ? `${info.guildName} / ${info.guildId}` : 'DM';
    this.info(
      `CommandUsed: ${info.discordUserName} / ${info.discordUserId} | ${guildText} #${shard} | ${info.commandResponse} | ${info.responseTimeMs}ms | ${info.messageContent}`
    );
  }

  public slashCommandUsed(info: {
    discordUserName: string;
    discordUserId: string;
    guildName?: string | null;
    guildId?: string | null;
    commandName: string;
    commandResponse: string;
    responseTimeMs: number;
  }): void {
    const guildText = info.guildName ? `${info.guildName} / ${info.guildId}` : 'UserApp';
    this.info(
      `SlashCommandUsed: ${info.discordUserName} / ${info.discordUserId} | ${guildText} | ${info.commandResponse} | ${info.responseTimeMs}ms | ${info.commandName}`
    );
  }

  public shardEvent(event: 'ready' | 'connected' | 'disconnected' | 'resumed', shardId: number, details?: string): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgBlue}${ansi.brightWhite}${ansi.bold} SHARD ${ansi.reset}`;
    const desc = details ? ` - ${details}` : '';
    this.emit(`${time} ${tag} ${ansi.brightBlue}Shard #${shardId} ${event}${desc}${ansi.reset}`);
  }

  public errorWithRef(
    error: unknown,
    context?: {
      commandName?: string;
      userName?: string;
      userId?: string;
      guildName?: string | null;
      guildId?: string | null;
      shardId?: number;
      messageContent?: string;
    }
  ): { referenceId: string; message: string } {
    const referenceId = this.generateReferenceId();
    const shard = context?.shardId ?? 0;
    const guildText = context?.guildName ? `${context.guildName} / ${context.guildId}` : 'DM';
    const userText = context?.userName ? `${context.userName} / ${context.userId}` : 'unknown';
    const contentText = context?.messageContent ?? (context?.commandName ? `.${context.commandName}` : 'unknown');

    const err = error instanceof Error ? error : new Error(String(error));
    this.error(
      `CommandUsed: Error ${referenceId} | ${userText} | ${guildText} #${shard} | Error (${err.message}) | ${contentText}`
    );
    if (err.stack) {
      const stackLines = err.stack.split('\n').map((l: string) => `    ${ansi.gray}${l.trim()}${ansi.reset}`);
      this.emit(stackLines.join('\n'));
    }

    return {
      referenceId,
      message: err.message,
    };
  }

private print(level: string, badge: string, textColor: string, msgOrObj: Loggable, extraArgs: unknown[]): void {
    const time = formatTimestamp();
    let message = '';
    let stackText: string | undefined;

    try {
      const composed = this.compose(msgOrObj, extraArgs);
      message = composed.message;
      stackText = composed.stack;
    } catch {
      // Even COMPOSING the line failed: a Proxy that traps `ownKeys`, a getter
      // that throws under the pino branch's rest-destructure, a `Symbol.toPrimitive`
      // that throws. The redaction layer absorbs the cases it knows about, so this
      // is the last net - and it is here because the alternative is the logger
      // throwing out of a catch block, which is the one outcome worse than a
      // missing diagnosis. The line goes out saying what happened to it rather
      // than not going out at all.
      message = '[a value in this log call could not be rendered]';
    }

    // The message is redacted BEFORE either sink sees it, so "scrubbed on stdout"
    // cannot become "clear text on disk" the moment someone reads the file. The
    // file sink applies `stripAnsi` on top; the redaction is upstream of that.
    message = redactSecrets(message);

    this.emit(`${time} ${badge} ${this.tracePrefix()}${textColor}${message}${ansi.reset}`);

    this.writeLogToFile(level, message, stackText);

    if ((level === 'ERROR' || level === 'FATAL') && stackText) {
      const stackLines = stackText.split('\n').map((l) => `    ${ansi.gray}${l.trim()}${ansi.reset}`);
      this.emit(stackLines.join('\n'));
    }
  }

  /**
   * Turn whatever the caller passed into message text plus an optional stack.
   * Every branch is individually guarded, AND `print` wraps this in a try/catch,
   * so a throw here costs the line's content and never the log call.
   */
  private compose(msgOrObj: Loggable, extraArgs: unknown[]): { message: string; stack?: string } {
    /**
     * The stack, resolved ONCE and for both sinks.
     *
     * They used to read different sources: stdout read `stackLike`, which accepts
     * any `{ stack: string }`, while the file sink received `errObject`, set only for
     * `instanceof Error`. So the same event was recorded with frames on stdout and
     * without them in the file whenever a caller attached a plain object, and "was
     * there a stack?" had two answers depending on which file you opened. One
     * resolution, one answer.
     */
    let stackText: string | undefined;
    let message: string;

    if (typeof msgOrObj === 'string') {
      message = msgOrObj;
      if (extraArgs.length > 0) {
        // The arguments are scrubbed too, because `%o` and `%j` INSPECT them: a
        // token passed as an extra argument is exactly as leaked as one passed as
        // the message, and the final pass over the formatted string cannot see it
        // under a denylisted key.
        const safeArgs = extraArgs.map((arg) => redactForLogValue(arg));
        // `util.format` was unguarded, and Node's `%s` handling calls
        // `String(arg)`, so an argument whose `toString` throws escaped the log
        // call and BECAME the incident. Reproduce the raw behaviour with:
        //   npx tsx -e "const u=require('util');try{u.format('x %s',{toString(){throw new Error('boom')}})}catch(e){console.log('THROWS',e.message)}"
        // A hostile argument must cost the ARGUMENT, never the line.
        try {
          message = util.format(msgOrObj, ...safeArgs);
        } catch {
          message = `${msgOrObj} ${safeArgs.map(describeSafely).join(' ')}`.trim();
        }
      }
    } else if (msgOrObj instanceof Error) {
      const safeErr = redactError(msgOrObj);
      message = safeErr.message;
      stackText = safeErr.stack;
    } else if (typeof msgOrObj === 'object' && msgOrObj !== null) {
      // Pino-style (context, message): never drop the context object — its
      // fields (guildId, severity, reason, ...) are the actual diagnostics.
      // Scrub it FIRST, so neither the message it carries nor the context dump
      // below can print a credential that arrived under a safe-looking field. The
      // result is NAMED rather than destructured off the raw value, because the
      // no-message branch below inspects the object again and must inspect the
      // scrubbed one: a text pass over the inspected output only catches the key
      // names the patterns happen to know.
      const scrubbed = redactForLogValue(msgOrObj) as Record<string, unknown>;
      const { err: errField, msg: msgField, ...contextRest } = scrubbed;
      if (errField) {
        // `err` is conventionally an Error, but callers sometimes attach a plain
        // object. Accept both and read the two fields this function needs, rather
        // than casting to Error and hoping.
        const errLike = errField as { message?: unknown; stack?: unknown };
        const errMessage = errLike.message;
        const errStack = errLike.stack;
        message =
          (typeof extraArgs[0] === 'string' ? extraArgs[0] : undefined) ??
          ((typeof errMessage === 'string' && errMessage) || 'Error occurred');
        if (typeof errStack === 'string' && errStack.length > 0) {
          stackText = errStack;
        }
      } else if (msgField) {
        // `as string` was the old cast here, and it lied: `msg` is `unknown`, so a
        // caller who passed a number or an object got a `message` that was not a
        // string, and the redaction pass downstream - which is `String.replace` -
        // would have thrown on it. `describeSafely` renders it the way the
        // template literal used to, so the visible output does not change.
        message = typeof msgField === 'string' ? msgField : describeSafely(msgField);
      } else if (extraArgs[0] && typeof extraArgs[0] === 'string') {
        message = extraArgs[0];
      } else {
        message = inspectValue(scrubbed, { colors: false, depth: 3 });
      }
      if (Object.keys(contextRest).length > 0) {
        message += ` ${inspectValue(contextRest, { colors: false, depth: 3, breakLength: 140 })}`;
      }
    } else {
      message = describeSafely(msgOrObj);
    }

    return { message, stack: stackText };
  }
}

export const Logger = new CustomLogger();
export type Logger = CustomLogger;
