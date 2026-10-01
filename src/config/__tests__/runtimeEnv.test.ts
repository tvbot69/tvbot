import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  errorWebhookUrl,
  ffmpegPath,
  ffprobePath,
  healthPort,
  redisUrl,
  setFfmpegPath,
  setFfprobePath,
  shardCount,
  shardingEnabledFlag,
  skipSlashRegister,
} from '@config/runtimeEnv';

/**
 * Every accessor in `runtimeEnv` is a pure function of an environment map, with
 * `process.env` as the default. That is the whole reason the `env` parameter
 * exists, and it is what makes this file testable without a save/restore dance
 * for the parse logic itself.
 *
 * The parse behaviour below is asserted twice, and the duplication is the
 * point, not an oversight:
 *
 *   - against a LITERAL env passed to the accessor. Fast, exhaustive, covers
 *     the malformed cases nobody types by hand.
 *   - against the REAL `process.env`. This is the assertion that would catch
 *     the failure mode a parse-level test cannot: an accessor that caches a
 *     value at import time instead of reading at call time. Every accessor has
 *     at least one such test, and the save/restore around them is what keeps
 *     that honest - the value has to genuinely come back changed.
 */

const OWNED_KEYS = [
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'REDIS_URL',
  'ERROR_WEBHOOK_URL',
  'SHARDING_ENABLED',
  'SHARD_COUNT',
  'SKIP_SLASH_REGISTER',
  'HEALTH_PORT',
  'PORT',
] as const;

type OwnedKey = (typeof OWNED_KEYS)[number];

/** Captured at file load, before any test mutates anything. */
const SAVED: Record<string, string | undefined> = {};
for (const key of OWNED_KEYS) SAVED[key] = process.env[key];

const setEnv = (key: OwnedKey, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  // Cleared, not merely restored to "whatever it was": a developer's real .env
  // is loaded by dotenv in any test file that imports configData, and a leaked
  // FFMPEG_PATH or SHARD_COUNT would make this file pass on one machine and
  // fail on another.
  for (const key of OWNED_KEYS) setEnv(key, undefined);
});

afterEach(() => {
  for (const key of OWNED_KEYS) setEnv(key, SAVED[key]);
});

/** The literal-env form, for the exhaustive parse cases. */
const envOf = (values: Partial<Record<OwnedKey, string>>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe('runtimeEnv: presence and blankness', () => {
  it('treats a present value as present', () => {
    expect(redisUrl(envOf({ REDIS_URL: 'redis://localhost:6379' }))).toBe('redis://localhost:6379');
    expect(errorWebhookUrl(envOf({ ERROR_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' }))).toBe('https://discord.com/api/webhooks/1/x');
    expect(ffmpegPath(envOf({ FFMPEG_PATH: '/usr/bin/ffmpeg' }))).toBe('/usr/bin/ffmpeg');
    expect(ffprobePath(envOf({ FFPROBE_PATH: '/usr/bin/ffprobe' }))).toBe('/usr/bin/ffprobe');
  });

  it('treats absent, empty and whitespace-only alike', () => {
    // The three are one case, not three. `|| 'default'` treated them as one,
    // so a blank webhook URL has to stay a no-op rather than becoming a fetch
    // to "".
    for (const blank of [undefined, '', '   ', '\t\n']) {
      const env = envOf({ REDIS_URL: blank as string | undefined });
      expect(redisUrl(env)).toBeUndefined();
      expect(errorWebhookUrl(envOf({ ERROR_WEBHOOK_URL: blank as string | undefined }))).toBeUndefined();
      expect(ffmpegPath(envOf({ FFMPEG_PATH: blank as string | undefined }))).toBeUndefined();
      expect(ffprobePath(envOf({ FFPROBE_PATH: blank as string | undefined }))).toBeUndefined();
    }
  });

  it('trims surrounding whitespace off a string value', () => {
    // Was the inline read trimmed? No. So this is the one documented liberty:
    // a path with a trailing space now resolves instead of failing existsSync.
    expect(redisUrl(envOf({ REDIS_URL: '  redis://host:6379  ' }))).toBe('redis://host:6379');
    expect(ffmpegPath(envOf({ FFMPEG_PATH: ' /usr/bin/ffmpeg ' }))).toBe('/usr/bin/ffmpeg');
  });
});

describe('runtimeEnv: booleans are strictly === "true"', () => {
  it('accepts only the exact string "true"', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'false', 'FALSE', '0', '', 'truthy', 'true1']) {
      expect(skipSlashRegister(envOf({ SKIP_SLASH_REGISTER: value }))).toBe(false);
    }
    expect(skipSlashRegister(envOf({ SKIP_SLASH_REGISTER: 'true' }))).toBe(true);
  });

  it('treats an absent boolean flag as false, not as an error', () => {
    expect(skipSlashRegister(envOf({}))).toBe(false);
  });

  it('tolerates padding around the flag', () => {
    // The trim liberty. ' true ' was false inline; it is true here. Nobody
    // sets it, and the strictness above is what actually protects the feature.
    expect(skipSlashRegister(envOf({ SKIP_SLASH_REGISTER: ' true ' }))).toBe(true);
  });
});

describe('runtimeEnv: SHARDING_ENABLED is a tri-state, not a boolean', () => {
  it('maps the two recognised literals and nothing else', () => {
    expect(shardingEnabledFlag(envOf({ SHARDING_ENABLED: 'true' }))).toBe('true');
    expect(shardingEnabledFlag(envOf({ SHARDING_ENABLED: 'false' }))).toBe('false');
  });

  it('degrades an unrecognised value to undefined so SHARD_COUNT can decide', () => {
    // Collapsing this to a boolean would make an absent flag read as "off" and
    // silently override SHARD_COUNT=4.
    for (const value of [undefined, '', '   ', 'TRUE', '1', 'yes', 'maybe'] as (string | undefined)[]) {
      expect(shardingEnabledFlag(envOf({ SHARDING_ENABLED: value as string }))).toBeUndefined();
    }
  });
});

describe('runtimeEnv: SHARD_COUNT', () => {
  it('parses a number, including the numeric-string forms Number() accepts', () => {
    expect(shardCount(envOf({ SHARD_COUNT: '4' }))).toBe(4);
    expect(shardCount(envOf({ SHARD_COUNT: ' 4 ' }))).toBe(4);
    expect(shardCount(envOf({ SHARD_COUNT: '0' }))).toBe(0);
    expect(shardCount(envOf({ SHARD_COUNT: '2.5' }))).toBe(2.5);
    // Number() takes hex. Preserved rather than "corrected", because the old
    // call site was literally Number() and callers compared on the result.
    expect(shardCount(envOf({ SHARD_COUNT: '0x10' }))).toBe(16);
  });

  it('returns undefined for absent, blank and unparseable alike', () => {
    // All three were `Number.isFinite(NaN) === false` at the old call sites, so
    // collapsing them to one answer changes no caller.
    for (const value of [undefined, '', '   ', 'abc', '4shards', 'NaN', 'Infinity'] as (string | undefined)[]) {
      expect(shardCount(envOf({ SHARD_COUNT: value as string }))).toBeUndefined();
    }
  });
});

describe('runtimeEnv: health port precedence', () => {
  it('prefers HEALTH_PORT, then PORT, then the caller fallback', () => {
    expect(healthPort(3000, envOf({ HEALTH_PORT: '8080', PORT: '9090' }))).toBe(8080);
    expect(healthPort(3000, envOf({ PORT: '9090' }))).toBe(9090);
    expect(healthPort(3000, envOf({}))).toBe(3000);
  });

  it('lets a blank HEALTH_PORT fall through to PORT rather than parsing as 0', () => {
    // `||` semantics preserved: an empty string is falsy, so PORT wins. Reading
    // it as port 0 here would silently bind a random port on every host that
    // ships HEALTH_PORT= with nothing after it.
    expect(healthPort(3000, envOf({ HEALTH_PORT: '', PORT: '9090' }))).toBe(9090);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '   ', PORT: '9090' }))).toBe(9090);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '', PORT: '' }))).toBe(3000);
  });

  it("treats '0' as a real port rather than a falsy string", () => {
    // '0' is truthy as a string, so `||` let it through, and Node's listen(0)
    // means "pick a free port". If this ever returns the fallback, something
    // has started parsing ports as numbers too early.
    expect(healthPort(3000, envOf({ HEALTH_PORT: '0', PORT: '9090' }))).toBe(0);
  });

  it('falls back rather than handing NaN or an impossible port to listen()', () => {
    // THE ONE DELIBERATE BEHAVIOUR CHANGE. Inline this was
    // `Number(a || b || port)`, so a typo in HEALTH_PORT produced NaN and
    // server.listen(NaN) threw ERR_SOCKET_BAD_PORT - a dead health endpoint at
    // boot, for a variable the operator believed was working.
    expect(healthPort(3000, envOf({ HEALTH_PORT: 'abc' }))).toBe(3000);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '80a' }))).toBe(3000);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '3.5' }))).toBe(3000);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '-1' }))).toBe(3000);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '70000' }))).toBe(3000);
    expect(healthPort(3000, envOf({ PORT: 'not-a-port' }))).toBe(3000);
  });

  it('accepts the boundary ports', () => {
    expect(healthPort(3000, envOf({ HEALTH_PORT: '1' }))).toBe(1);
    expect(healthPort(3000, envOf({ HEALTH_PORT: '65535' }))).toBe(65535);
  });
});

describe('runtimeEnv: the ffmpeg/ffprobe write-back', () => {
  it('publishes the resolved binary back to the environment', () => {
    // Not a leftover. voiceMessageService reads FFPROBE_PATH to hand a path to
    // get-audio-duration; on Windows its own /usr/bin/ffprobe fallback does not
    // exist, so without this write-back every voice message is stuck at the
    // hardcoded 30s. Both sides of the round trip are asserted, so deleting
    // either the setter or the accessor turns this red.
    setFfprobePath('/opt/ffprobe');
    expect(process.env.FFPROBE_PATH).toBe('/opt/ffprobe');
    expect(ffprobePath()).toBe('/opt/ffprobe');

    setFfmpegPath('/opt/ffmpeg');
    expect(process.env.FFMPEG_PATH).toBe('/opt/ffmpeg');
    expect(ffmpegPath()).toBe('/opt/ffmpeg');
  });

  it('trims what it writes and refuses to blank a good path', () => {
    setFfprobePath('/opt/ffprobe');
    setFfprobePath('   ');
    expect(process.env.FFPROBE_PATH).toBe('/opt/ffprobe');
    setFfmpegPath('/opt/ffmpeg');
    setFfmpegPath('');
    expect(process.env.FFMPEG_PATH).toBe('/opt/ffmpeg');
  });
});

describe('runtimeEnv: reads the LIVE environment, not a cached snapshot', () => {
  // Each of these is the same shape and the same reason: an accessor that read
  // process.env at import time (or memoised on first call) would return the
  // FIRST value for all three assertions. The save/restore in afterEach is what
  // lets them share a process without leaking into the rest of the suite.
  it('ffmpegPath', () => {
    expect(ffmpegPath()).toBeUndefined();
    process.env.FFMPEG_PATH = '/first';
    expect(ffmpegPath()).toBe('/first');
    process.env.FFMPEG_PATH = '/second';
    expect(ffmpegPath()).toBe('/second');
    delete process.env.FFMPEG_PATH;
    expect(ffmpegPath()).toBeUndefined();
  });

  it('ffprobePath', () => {
    expect(ffprobePath()).toBeUndefined();
    process.env.FFPROBE_PATH = '/first';
    expect(ffprobePath()).toBe('/first');
    process.env.FFPROBE_PATH = '/second';
    expect(ffprobePath()).toBe('/second');
    delete process.env.FFPROBE_PATH;
    expect(ffprobePath()).toBeUndefined();
  });

  it('redisUrl', () => {
    expect(redisUrl()).toBeUndefined();
    process.env.REDIS_URL = 'redis://a:6379';
    expect(redisUrl()).toBe('redis://a:6379');
    process.env.REDIS_URL = 'redis://b:6379';
    expect(redisUrl()).toBe('redis://b:6379');
    delete process.env.REDIS_URL;
    expect(redisUrl()).toBeUndefined();
  });

  it('errorWebhookUrl', () => {
    expect(errorWebhookUrl()).toBeUndefined();
    process.env.ERROR_WEBHOOK_URL = ' https://a/1 ';
    expect(errorWebhookUrl()).toBe('https://a/1');
    process.env.ERROR_WEBHOOK_URL = 'https://b/2';
    expect(errorWebhookUrl()).toBe('https://b/2');
    delete process.env.ERROR_WEBHOOK_URL;
    expect(errorWebhookUrl()).toBeUndefined();
  });

  it('shardingEnabledFlag', () => {
    expect(shardingEnabledFlag()).toBeUndefined();
    process.env.SHARDING_ENABLED = 'true';
    expect(shardingEnabledFlag()).toBe('true');
    process.env.SHARDING_ENABLED = 'false';
    expect(shardingEnabledFlag()).toBe('false');
    delete process.env.SHARDING_ENABLED;
    expect(shardingEnabledFlag()).toBeUndefined();
  });

  it('shardCount', () => {
    expect(shardCount()).toBeUndefined();
    process.env.SHARD_COUNT = '2';
    expect(shardCount()).toBe(2);
    process.env.SHARD_COUNT = '8';
    expect(shardCount()).toBe(8);
    process.env.SHARD_COUNT = 'nope';
    expect(shardCount()).toBeUndefined();
    delete process.env.SHARD_COUNT;
    expect(shardCount()).toBeUndefined();
  });

  it('skipSlashRegister', () => {
    expect(skipSlashRegister()).toBe(false);
    process.env.SKIP_SLASH_REGISTER = 'true';
    expect(skipSlashRegister()).toBe(true);
    process.env.SKIP_SLASH_REGISTER = 'false';
    expect(skipSlashRegister()).toBe(false);
    delete process.env.SKIP_SLASH_REGISTER;
    expect(skipSlashRegister()).toBe(false);
  });

  it('healthPort', () => {
    expect(healthPort(3000)).toBe(3000);
    process.env.HEALTH_PORT = '8080';
    expect(healthPort(3000)).toBe(8080);
    delete process.env.HEALTH_PORT;
    process.env.PORT = '9090';
    expect(healthPort(3000)).toBe(9090);
    delete process.env.PORT;
    expect(healthPort(3000)).toBe(3000);
  });
});

describe('runtimeEnv: totality', () => {
  it('no accessor throws for any value of its key', () => {
    // The property that keeps the bot booting. cacheService and shardManager
    // are read during DI wiring and before the client exists; errorFeed is read
    // from an uncaughtException handler. A config module that threw turned every
    // one of those from degraded into down.
    const hostile = ['', '   ', 'true', 'false', '0', '-1', 'NaN', 'Infinity', '1e400', ' ', '🙂', '0x', '1,2'];
    for (const value of hostile) {
      const env = envOf({
        FFMPEG_PATH: value,
        FFPROBE_PATH: value,
        REDIS_URL: value,
        ERROR_WEBHOOK_URL: value,
        SHARDING_ENABLED: value,
        SHARD_COUNT: value,
        SKIP_SLASH_REGISTER: value,
        HEALTH_PORT: value,
        PORT: value,
      });
      expect(() => ffmpegPath(env)).not.toThrow();
      expect(() => ffprobePath(env)).not.toThrow();
      expect(() => redisUrl(env)).not.toThrow();
      expect(() => errorWebhookUrl(env)).not.toThrow();
      expect(() => shardingEnabledFlag(env)).not.toThrow();
      expect(() => shardCount(env)).not.toThrow();
      expect(() => skipSlashRegister(env)).not.toThrow();
      expect(() => healthPort(3000, env)).not.toThrow();
    }
  });

  it('does not consult keys it does not own', () => {
    // A single mis-typed key name would silently make an accessor always
    // return its default, which is invisible at boot. Pinning the key names
    // here is cheaper than finding that from a symptom.
    const env = envOf({
      FFMPEG_PATH: '/a',
      FFPROBE_PATH: '/b',
      REDIS_URL: 'redis://c',
      ERROR_WEBHOOK_URL: 'https://d',
      SHARDING_ENABLED: 'true',
      SHARD_COUNT: '4',
      SKIP_SLASH_REGISTER: 'true',
      HEALTH_PORT: '1234',
      PORT: '5678',
    });
    expect(ffmpegPath(env)).toBe('/a');
    expect(ffprobePath(env)).toBe('/b');
    expect(redisUrl(env)).toBe('redis://c');
    expect(errorWebhookUrl(env)).toBe('https://d');
    expect(shardingEnabledFlag(env)).toBe('true');
    expect(shardCount(env)).toBe(4);
    expect(skipSlashRegister(env)).toBe(true);
    expect(healthPort(3000, env)).toBe(1234);
  });

  it('ignores an environment argument of undefined by falling back to the process', () => {
    // The default-parameter path that `shouldShard` and every call site relies
    // on. If the default ever stopped defaulting, every accessor would return
    // undefined in production and nothing would throw.
    process.env.REDIS_URL = 'redis://live:6379';
    expect(redisUrl(undefined)).toBe('redis://live:6379');
    expect(healthPort(3000, undefined)).toBe(3000);
  });
});
