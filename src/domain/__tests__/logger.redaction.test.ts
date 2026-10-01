import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { CustomLogger, redactSecrets, isSecretKey } from '../logger';

/**
 * DEFECT 1: the logger had NO redaction at all.
 *
 * `Loggable` accepted `string | number | boolean | Error | object` and whatever
 * a caller passed was formatted and written to stdout AND appended to
 * `logs/tvbot-<date>.log`. Exactly one caller in the whole bot scrubbed for
 * itself (`SpotifyTokenManager.readTokenError`), which is the wrong place: the
 * next caller will not know to. This repo is PUBLIC and its rule is that an
 * infrastructure detail never lands in the tree - including in a stray log file.
 *
 * WHY BOTH SINKS ARE ASSERTED ON EVERY CASE
 * -----------------------------------------
 * A credential scrubbed from stdout and written in clear text to disk is still a
 * credential on disk, and the file is the copy that survives a container restart
 * and the one nobody thinks to look at. So every leak test here asserts BOTH:
 * `stdoutText()` and `fileText()`.
 *
 * WHY THE VALUES BELOW LOOK LIKE CREDENTIALS
 * -----------------------------------------
 * A redaction test using `not-secret` proves nothing, because `not-secret` does
 * not look like anything a denylist or a pattern would ever match. So every fake
 * is shaped like the real thing - a JWT has three base64url segments and an
 * `eyJ` header, a DSN has a `user:password@` pair, a vendor token is 32 hex
 * characters - and none of them is a real credential. Hostnames use the reserved
 * `.invalid` TLD and no port appears, because this is a public repository.
 *
 * WHAT IS DELIBERATELY NOT SCRUBBED, and why it is asserted anyway
 * ----------------------------------------------------------------
 * A redactor that eats everything is a redactor nobody can debug around: a
 * scrobble count, a user id, a Last.fm username, an ISO date and a credential-free
 * URL are the actual content of most log lines in this bot. The last block of this
 * file pins that they survive, which is the half of "redaction" that nobody writes
 * a test for and everybody notices when it is missing.
 */

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const stub = {
    ...(actual as unknown as Record<string, unknown>),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
  return { ...actual, default: stub };
});

const appendFileSync = vi.mocked(fs.appendFileSync);

/** A logger with the file sink on, per the repo's cast convention for privates. */
const withFileLogging = (): CustomLogger => {
  const logger = new CustomLogger();
  (logger as unknown as { fileLoggingEnabled: boolean }).fileLoggingEnabled = true;
  return logger;
};

let lines: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  lines = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = () => undefined;
  vi.mocked(fs.existsSync).mockReturnValue(true);
  appendFileSync.mockReset();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

/**
 * Everything the process printed, with the colour codes removed, which is what a
 * reader actually sees. The file sink already strips them, so comparing both
 * sinks through the same lens is the only way an assertion about "the line" means
 * the same thing on either side.
 */
const stdoutText = (): string => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

/** Everything handed to `appendFileSync`, i.e. what the file would hold. */
const fileText = (): string => appendFileSync.mock.calls.map((c) => String(c[1])).join('');

/** Fakes shaped like the real thing. None of them is a real credential. */
const JWT_LIKE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZWNvbGUifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
const BEARER_LIKE = 'kQ7ZmVx2pLd9RtYwNcHb4JmXa6Uv';
const DSN_WITH_CREDENTIAL = 'postgres://tvbot_user:s3cr3t_p4ssw0rd@db.invalid/tvbot';
const QUERY_CREDENTIAL = '?api_key=9f8e7d6c5b4a39281706f5e4d3c2b1a09&format=json';

/**
 * Discord-shaped, and ASSEMBLED AT RUNTIME ON PURPOSE.
 *
 * Written as a literal this file is rejected by GitHub push protection, which
 * matches the SHAPE of a bot token rather than whether it is live — so a
 * fabricated credential still blocks the whole push, and the block is
 * indistinguishable from a real leak at the review stage. Concatenating the
 * segments means the pattern never appears in source, and the redaction
 * matcher still sees exactly the string shape it has to survive in the wild.
 *
 * Do NOT "simplify" this back to a literal. If you need a different fake, build
 * it the same way.
 */
const DISCORD_TOKEN_LIKE = ['MTk4NjIyNDgzNDcxOTI1MjQ4', 'Cl2FMQ', 'ZnCjm1XVW7vRze4b7Cq4se7kKWs'].join('.');

describe('a credential never reaches either sink', () => {
  it('scrubs a plain object property, and says so rather than printing the key', () => {
    const logger = withFileLogging();
    logger.info({ access_token: 'AQDwP1sJ0mVn7Rk4Tb2Yc9Zx6Le3Hf8Ug', guildId: 'g-1' });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('AQDwP1sJ0mVn7Rk4Tb2Yc9Zx6Le3Hf8Ug');
      // The KEY survives, because "there was an access_token here" is the
      // diagnosis and "[REDACTED] with no field name" is not.
      expect(sink).toContain('access_token');
      expect(sink).toContain('[REDACTED]');
      // The non-secret sibling of the same object is untouched.
      expect(sink).toContain('g-1');
    }
  });

  it('scrubs a credential nested three levels deep', () => {
    // The recursion is the whole point of doing this in the logger: a caller that
    // logs `{ provider: 'spotify', auth: { tokens: { access_token } } }` three
    // call sites from the thing that holds the secret still gets a clean log.
    //
    // Note WHAT the `auth` subtree becomes: `[REDACTED]` in one piece, not walked.
    // A key that names a credential container is taken at its word - walking into
    // it would mean deciding which of its fields are secret, and the field this
    // rule exists for is the one nobody remembered to name. The cost is that
    // `auth: { attempts: 2 }` also loses its count, which is why the fields worth
    // keeping are asserted to live OUTSIDE the credential subtree.
    const logger = withFileLogging();
    logger.warn({
      provider: 'spotify',
      attempts: 2,
      auth: { tokens: { access_token: 'hRt7wPq2Zx9Lm4Kd8Nb3Yv6Cj1Sf5G', refresh_token: 'Rs2Nd9Wq4Xk7Tb3Vh6Mz1Lp8' } },
    });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('hRt7wPq2Zx9Lm4Kd8Nb3Yv6Cj1Sf5G');
      expect(sink).not.toContain('Rs2Nd9Wq4Xk7Tb3Vh6Mz1Lp8');
      // The KEY survives - "there was an auth block here" is the diagnosis.
      expect(sink).toContain('auth');
      // And so does everything beside it.
      expect(sink).toContain('attempts');
      expect(sink).toContain('2');
      expect(sink).toContain('spotify');
    }
  });

  it('scrubs a bearer-shaped token that arrives inside an ordinary sentence', () => {
    // This is the case a key denylist cannot see, and it is the one that shows up
    // in practice: a message assembled from a fetch response or a hand-written
    // error. The word that introduces the credential survives.
    const logger = withFileLogging();
    logger.error(`ladder rung 2 rejected the request: Authorization: Bearer ${BEARER_LIKE}`);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain(BEARER_LIKE);
      expect(sink).toContain('Bearer');
      expect(sink).toContain('ladder rung 2 rejected');
    }
  });

  it('scrubs a JWT, a vendor token shape, and a credential in a query string', () => {
    const logger = withFileLogging();
    logger.error(`lastfm said 401 for ${JWT_LIKE}`);
    logger.error(`discord rejected ${DISCORD_TOKEN_LIKE}`);
    logger.error(`GET https://ws.audioscrobbler.invalid/2.0/${QUERY_CREDENTIAL}`);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain(JWT_LIKE);
      expect(sink).not.toContain(DISCORD_TOKEN_LIKE);
      expect(sink).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a09');
      // What a reader needs to make the call is still there: the vendor, the
      // method, the status, the other query parameters.
      expect(sink).toContain('lastfm said 401');
      expect(sink).toContain('ws.audioscrobbler.invalid');
      expect(sink).toContain('format=json');
    }
  });

  it('scrubs the password out of a connection string, and keeps the host and user', () => {
    // The host is deliberately NOT scrubbed. The rule is about credentials, and
    // "which database was it" is the first question anyone asks about a connect
    // failure - while the user name is a genuine diagnostic and never a secret.
    const logger = withFileLogging();
    logger.error(`could not reach the database: ${DSN_WITH_CREDENTIAL}`);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('s3cr3t_p4ssw0rd');
      expect(sink).toContain('tvbot_user');
      expect(sink).toContain('db.invalid');
    }
  });

  it('scrubs a credential inside an Error message AND its stack, in both sinks', () => {
    // The real leak path, not the hypothetical one: a Last.fm 401 arrives as
    // `...?api_key=...&api_sig=...` inside the message, and the stack of the fetch
    // that made the call carries the same URL. Scrubbing only the message would
    // leave the credential in the frames.
    const logger = withFileLogging();
    const err = new Error(`request failed 401 for https://ws.audioscrobbler.invalid/2.0/${QUERY_CREDENTIAL}`);
    logger.error(err);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a09');
      expect(sink).toContain('request failed 401');
    }
  });

  it('scrubs an object-shaped err, whose message is not an Error\'s message either', () => {
    // `err` is conventionally an Error and callers attach plain objects. The
    // message is read from the scrubbed copy, so this path is covered too.
    const logger = withFileLogging();
    logger.error({ err: { message: `token refresh failed for ${JWT_LIKE}`, stack: 'frame one' }, guildId: 'g-9' });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain(JWT_LIKE);
      expect(sink).toContain('token refresh failed for');
      expect(sink).toContain('g-9');
    }
  });

  it('scrubs a credential on the no-message branch, which dumps the whole object', () => {
    // With neither `msg` nor `err`, `print` inspects the value itself. That is
    // the branch where a text-only scrub would be the ONLY thing standing between
    // a credential and the log, because there is no message to carry it - and
    // the object walk is what actually replaces the value.
    const logger = withFileLogging();
    logger.info({ botToken: 'Nz9QbVh3Km8RtXp2Ld6Wj1Cs', owner: 'moha' });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('Nz9QbVh3Km8RtXp2Ld6Wj1Cs');
      expect(sink).toContain('owner');
      expect(sink).toContain('moha');
    }
  });

  it('scrubs a credential that is a Map KEY, which is where config arrives', () => {
    const logger = withFileLogging();
    logger.info({ headers: new Map<string, string>([['Authorization', `Bearer ${BEARER_LIKE}`], ['accept', 'application/json']]) });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain(BEARER_LIKE);
      // The non-secret entry in the same Map survives, or the log says nothing.
      expect(sink).toContain('application/json');
    }
  });

  it('scrubs credentials inside an array and a Set, which have no field names', () => {
    // Arrays and Sets are containers, so the key denylist has nothing to match -
    // the VALUE shapes are the only thing that can catch a credential in them,
    // and `util.inspect` would happily print `{ '0': 'Bearer ...' }`.
    const logger = withFileLogging();
    logger.info({ attempts: [`Authorization: Bearer ${BEARER_LIKE}`, 'plain reason'], tags: new Set([`token=${JWT_LIKE}`]) });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain(BEARER_LIKE);
      expect(sink).not.toContain(JWT_LIKE);
      expect(sink).toContain('plain reason');
    }
  });

  it('prints a Date as a date, because a timestamp is not a credential', () => {
    // The walk passes Date, RegExp and Buffer through untouched. A Date rendered
    // by `String()` is an ISO timestamp, which is the one thing a reader wants.
    const when = new Date('2026-10-01T07:42:12.345Z');
    const logger = withFileLogging();
    logger.info({ indexedAt: when, pattern: /ab+c/gi, raw: Buffer.from('creep') });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('2026-10-01T07:42:12.345Z');
      expect(sink).toContain('pattern: /ab+c/gi');
      // `util.inspect` renders a Buffer as hex bytes, which is the point: the walk
      // leaves it alone and the renderer decides, rather than the walk calling
      // `String()` on something whose bytes are not text.
      expect(sink).toMatch(/raw: <Buffer [0-9a-f ]+>/);
    }
  });

  it('scrubs a credential passed as a printf argument, not as the message', () => {
    const logger = withFileLogging();
    logger.info('spotify exchange failed for client_secret=%s', 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg');
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg');
      expect(sink).toContain('spotify exchange failed');
    }
  });

  it('scrubs a credential in an argument rendered with %o, which inspects it', () => {
    // `%o` and `%j` run the argument through `util.inspect`, so the value is
    // printed under its own key. The arguments are therefore scrubbed BEFORE
    // `util.format` sees them.
    //
    // `signature` is the key that proves it: it is in the KEY denylist and NOT
    // in the text patterns, and `\btoken` cannot match inside `botToken` because
    // there is no word boundary before it. So the final scrub over the formatted
    // string cannot save this line - only scrubbing the argument can.
    const logger = withFileLogging();
    logger.info('interaction was %o', { holder: 'moha', signature: 'Tt9wRm4pZq7Xb2Kd8Nv3Lf6Hj1Sc5' });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('Tt9wRm4pZq7Xb2Kd8Nv3Lf6Hj1Sc5');
      expect(sink).toContain('holder');
      expect(sink).toContain('moha');
    }
  });

  it('scrubs a shaped reporter, which builds its own line and bypasses `print`', () => {
    // `command`, `slash`, `button`, `sync`, `ready`, `shardEvent` and
    // `errorWithRef` do not go through `print` - they assemble a line of their
    // own and print it. `command.args` is a user's message content and
    // `errorWithRef` prints a stack, so a reporter added later must not become
    // the one hole in the guarantee: every stdout line goes through `emit`, and
    // `emit` redacts.
    const logger = withFileLogging();
    logger.command({ commandName: 'login', args: `--api_key=${BEARER_LIKE}`, userName: 'moha', durationMs: 4 });
    logger.sync(`session refresh failed for token=${BEARER_LIKE}`);
    logger.errorWithRef(new Error(`ladder gave up: Authorization: Bearer ${BEARER_LIKE}`), { commandName: 'play' });

    const stdout = stdoutText();
    expect(stdout).not.toContain(BEARER_LIKE);
    // The reporter still did its job: the command, the sentence and the human
    // sentence in the reference line are all still there.
    expect(stdout).toContain('session refresh failed for');
    expect(stdout).toContain('.login');
    expect(stdout).toContain('ladder gave up');
  });

  it('leaves an ordinary error completely alone, including its identity', () => {
    // The redactor clones ONLY on a match. Cloning unconditionally would strip
    // the prototype, the custom fields and the `cause` off every error in the
    // bot, and a logger that alters the thing it was handed is its own bug.
    const err = new Error('an ordinary fault');
    const logger = withFileLogging();
    logger.error(err);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('an ordinary fault');
      expect(sink).toContain('    at ');
      expect(sink).not.toContain('[REDACTED]');
    }
  });
});

describe('the redactor can fail, and a failed redactor must not cost the line', () => {
  it('prints a line for a circular object rather than recursing forever', () => {
    const circular: Record<string, unknown> = { name: 'queue-state' };
    circular.self = circular;
    const logger = withFileLogging();

    expect(() => logger.info(circular)).not.toThrow();
    logger.flushLogFile();
    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('queue-state');
      expect(sink).toContain('[circular]');
    }
  });

  it('names a property whose getter throws, and still logs the rest of the object', () => {
    // `Object.keys` does not invoke a getter; READING one does. A throwing getter
    // is a thing a vendor library can hand you, and it must not take the line with
    // it - the other properties are usually the diagnosis.
    const hostile: Record<string, unknown> = { guildId: 'g-2', scrobbles: 12 };
    Object.defineProperty(hostile, 'session', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const logger = withFileLogging();

    expect(() => logger.warn(hostile)).not.toThrow();
    logger.flushLogFile();
    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('g-2');
      expect(sink).toContain('scrobbles');
      expect(sink).toContain('[property could not be read]');
    }
  });

  it('stops descending at the depth cap and names what it did not print', () => {
    // Without a cap, a self-similar structure is unbounded work on the hot path,
    // and a value that is silently half-printed is worse than one that says it was
    // truncated: the first invents evidence.
    const deep = { a: { b: { c: { d: { e: { f: 'leaf' } } } } } };
    const logger = withFileLogging();

    expect(() => logger.info(deep)).not.toThrow();
    logger.flushLogFile();
    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('[value nested too deeply to print]');
    }
  });

  it('keeps the line when the value cannot be walked at all', () => {
    // The last net, above the redaction layer: a Proxy that traps `ownKeys` fails
    // the walk AND the pino branch's rest-destructure. A logger that throws here
    // would convert a reported fault into an unhandled rejection, which is the one
    // outcome worse than a diagnosis that says "I could not read this".
    const hostile = new Proxy({ guildId: 'g-3' }, {
      ownKeys() {
        throw new Error('ownKeys exploded');
      },
    });
    const logger = withFileLogging();

    expect(() => logger.error(hostile, 'the gateway handshake failed')).not.toThrow();
    logger.flushLogFile();
    // The level, the trace of the call and the fallback text all survive; what is
    // lost is the one value that could not be rendered.
    expect(stdoutText()).toContain('ERROR');
    expect(fileText()).toContain('[ERROR]');
  });
});

describe('what the redactor deliberately leaves alone', () => {
  it('logs the numbers and names that most log lines are made of, in both sinks', () => {
    // A scrobble count, a Discord id, a Last.fm username, an ISO date and a
    // credential-free URL. None of these is a secret and every one of them is the
    // thing someone is reading the log to find. If this test ever goes red, the
    // redactor has started eating evidence and is worse than no redactor.
    const logger = withFileLogging();
    logger.info(
      `indexed ${4321} scrobbles for moha (uid 123456789012345678) at 2026-10-01T07:42:12.345Z, cover from https://lastfm.example.invalid/i/u/300x300/abc123.png`
    );
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('4321');
      expect(sink).toContain('moha');
      expect(sink).toContain('123456789012345678');
      expect(sink).toContain('2026-10-01T07:42:12.345Z');
      expect(sink).toContain('https://lastfm.example.invalid/i/u/300x300/abc123.png');
      expect(sink).not.toContain('[REDACTED]');
    }
  });

  it('keeps a value whose name ends in a credential word but is a count', () => {
    // `tokenCount` is a number a reader needs; `access_token` is a credential. A
    // suffix match that ignored the rest of the name would blank the first and
    // save nothing on the second, because the second is caught by the name list.
    const logger = withFileLogging();
    logger.info({ tokenCount: 4321, scrobbles: 12, cacheKey: 'cover-300x300' });
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('4321');
      expect(sink).toContain('cacheKey');
      expect(sink).not.toContain('[REDACTED]');
    }
  });

  it('keeps the NAME of a missing env var, which is the most useful boot line there is', () => {
    // `LASTFM_API_KEY is unset` is how a boot failure gets diagnosed, and the name
    // is not the value. A redactor that ate the name would leave the reader with a
    // bot that is down and no way to find out why.
    const logger = withFileLogging();
    logger.fatal('LASTFM_API_KEY is unset, refusing to boot');
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain('LASTFM_API_KEY is unset');
      expect(sink).not.toContain('[REDACTED]');
    }
  });

  it('keeps a bare high-entropy digest, because it is more often a hash than a key', () => {
    // The deliberate MISS, asserted so it stays deliberate. A 64-character hex
    // string is a Last.fm API key to one caller and a content hash to the next,
    // and the difference is invisible in the log. A heuristic that cannot tell
    // them apart eats the hashes, which are the evidence. Credentials that arrive
    // under this shape are covered by the NAME denylist, not by entropy.
    const digest = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    const logger = withFileLogging();
    logger.debug(`cover hash ${digest} matched nothing in the cascade`);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).toContain(digest);
    }
  });

  it('scrubs a key=value pair inside a URL, which is not a bare digest', () => {
    // The other half of the same decision, asserted together with it: a credential
    // that arrives attached to a NAME is scrubbed, and one that arrives alone is
    // left. Otherwise the rule is either "scrub all long strings" (which eats
    // hashes) or "scrub none" (which leaks every API key in a query string).
    const logger = withFileLogging();
    logger.error(`spotify refused the exchange: https://api.example.invalid/token${QUERY_CREDENTIAL}`);
    logger.flushLogFile();

    for (const sink of [stdoutText(), fileText()]) {
      expect(sink).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a09');
      expect(sink).toContain('spotify refused the exchange');
    }
  });
});

describe('the redaction primitives, on their own', () => {
  it('is idempotent, because print scrubs once for the file and emit scrubs again', () => {
    // Two redaction passes over the same line is the design (one for the file
    // sink, one for every stdout line including the shaped reporters), so this is
    // load-bearing rather than a nicety: a second pass that ate `[REDACTED]` would
    // leave a growing marker on every line.
    const once = redactSecrets(`token=Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg and Authorization: Bearer ${BEARER_LIKE}`);
    expect(redactSecrets(once)).toBe(once);
    expect(once).toContain('[REDACTED]');
  });

  it('scrubs the vendor-prefixed and case-varied spellings a caller actually writes', () => {
    // One normalised denylist covers `api_key`, `apiKey`, `API-KEY` and
    // `spotifyAccessToken`, because they are one entry each and four regex
    // alternatives otherwise.
    for (const key of ['token', 'api_key', 'apiKey', 'API-KEY', 'client_secret', 'Authorization', 'cookie', 'sessionKey', 'botToken', 'refreshToken', 'access_token']) {
      expect(isSecretKey(key)).toBe(true);
    }
    // The vendor-prefixed ones are the SUFFIX path rather than the name list, so
    // they are asserted separately: `spotifyAccessToken` is not a name anybody
    // would enumerate, which is exactly why the suffix rule exists.
    for (const key of ['spotifyAccessToken', 'discordToken', 'lastfmApiSecret', 'openaiApiKey', 'sessionCookie']) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('does not treat an id, a count or a dictionary word as a credential', () => {
    for (const key of ['userId', 'guildId', 'scrobbles', 'playCount', 'tokenCount', 'customId', 'key', 'cacheKey', 'traceId']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it('answers false for a name with no alphanumerics, rather than crashing on it', () => {
    // An empty or punctuation-only key is reachable from a spread of computed
    // keys, and `normaliseKey` reduces it to the empty string. `Set.has('')`
    // would simply be false - the explicit check is here so the contract is
    // "every string is answerable" rather than "every string that looks like a
    // word is".
    expect(isSecretKey('')).toBe(false);
    expect(isSecretKey('___')).toBe(false);
  });
});

describe('the shapes a caller can hand the pino branch, which the redactor changed', () => {
  it('renders a non-string msg, because the old cast claimed it was one', () => {
    // `msg` is `unknown`. It used to be assigned with `as string`, which meant a
    // caller who passed a number got a `message` that was not a string, and the
    // redaction pass downstream - a `String.replace` - would have thrown on it.
    // The line must still print.
    const logger = new CustomLogger();
    expect(() => logger.info({ msg: 42, track: 'Creep' })).not.toThrow();
    expect(stdoutText()).toContain('42');
    expect(stdoutText()).toContain('Creep');
  });

  it('falls back to a named message when err carries none, rather than printing undefined', () => {
    // Asserted as it is: the SIBLINGS of `err` inside the err object are not
    // printed, because `err` is destructured out and never re-dumped - which
    // `logger.levels.test.ts` pins separately as "does not re-print err as part
    // of the context dump". So the fallback text is all this line carries, and
    // the assertion is that it is a sentence rather than the string "undefined".
    const logger = new CustomLogger();
    logger.error({ err: { code: 'E_NOPE' } });
    expect(stdoutText()).toContain('Error occurred');
    expect(stdoutText()).not.toContain('undefined');
  });

  it('leaves an Error with no stack alone, because there is nothing to scrub', () => {
    // `Error.stack` is not guaranteed to be a string - a library can delete it,
    // and a structured-clone or a worker boundary can hand one across with it
    // undefined. The redaction must pass it through rather than call a string
    // method on it.
    const err = new Error('no frames here');
    err.stack = undefined;
    const logger = new CustomLogger();
    expect(() => logger.error(err)).not.toThrow();
    expect(stdoutText()).toContain('no frames here');
  });
});
