/**
 * Runtime environment accessors.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A raw `process.env.X` read at a call site forces every reader to re-derive
 * three things: what an absent value means, what a blank value means, and what a
 * malformed value means. Those answers were inconsistent across the codebase -
 * `!!process.env.REDIS_URL` treats a blank as absent, `Number(process.env.X ||
 * fallback)` treats garbage as `NaN` and hands that to `listen()`, and
 * `process.env.X === 'true'` treats `'TRUE'` as false. Each of those is
 * defensible in isolation; the spread is the problem.
 *
 * So every runtime `process.env` read outside `configData`/`lavalink` goes
 * through one of the accessors below, and the parsing rule for a key is stated
 * once, here, with a type.
 *
 * THREE PROPERTIES THIS MODULE PROMISES
 * -------------------------------------
 *
 * 1. LAZY. Nothing is read at import time. `cacheService` and `shardManager`
 *    are read during DI wiring and `shardManager` is read by `bot/index.ts`
 *    before the client exists; a module that snapshotted the environment at
 *    import would capture a pre-`dotenv` snapshot on any import path that
 *    happens to reach it first. Every accessor reads `process.env` at CALL
 *    time, so the timing is identical to an inline read at the call site.
 *
 * 2. TOTAL. No accessor throws. An absent or blank variable is a normal
 *    condition (a dev with no Redis, a deploy with no error webhook), and the
 *    call sites that read these keys already handled absence - `errorFeed` is
 *    a quiet no-op, `CacheService` falls back to an in-memory LRU. A config
 *    module that throws would turn every one of those from degraded into down,
 *    which is the opposite of the behaviour being preserved.
 *
 * 3. IMPORT-FREE. No imports at all, deliberately. `configData` is the one
 *    module allowed to run `dotenv/config` and `assertValidEnvironment`, both
 *    of which have side effects and both of which run from a lazy getter. This
 *    module must not add a second dotenv load, and being a leaf it cannot
 *    participate in an import cycle - `npm run deps:cycles` holds a budget of
 *    ZERO runtime cycles, and that budget is not worth spending on a config
 *    accessor. `src/config/lavalink.ts` does import Logger; this one does not,
 *    because it has nothing to say.
 *
 * The `env` parameter is why `shouldShard` can still be tested with a literal
 * `{ SHARDING_ENABLED: 'true' }` while the actual read lives here. It defaults
 * to `process.env`, so `accessor()` is the lazy read and `accessor(env)` is a
 * pure function of a given environment.
 */

/** A trimmed, non-empty value, or undefined when absent or blank. */
export type EnvString = string | undefined;

/** The three states `SHARDING_ENABLED` can be in. Tri-state on purpose: the
 *  absence of the flag is NOT the same as `false`, because an absent flag
 *  defers to SHARD_COUNT. Collapsing this to a boolean would make
 *  `SHARDING_ENABLED` unset override `SHARD_COUNT=4`, which is the opposite of
 *  what the flag means. */
export type ShardingFlag = 'true' | 'false' | undefined;

/** A path to a system binary, or undefined when unconfigured. */
export type BinaryPath = string | undefined;

/** An integer count parsed from the environment, or undefined when absent,
 *  blank, or not a finite number. Distinct from 0: `SHARD_COUNT=0` is a
 *  configured count, `SHARD_COUNT=abc` is not a count at all. */
export type EnvCount = number | undefined;

const MAX_TCP_PORT = 65535;

/** The environment an accessor reads when the caller does not supply one.
 *  A function call, not a constant, so a test that mutates `process.env` after
 *  import still sees its own value. */
const currentEnv = (): NodeJS.ProcessEnv => process.env;

/** Trimmed, or undefined for absent/empty/whitespace-only.
 *
 * The `value ? value : undefined` (rather than `?? undefined`) is deliberate:
 *  `'   '` must read as absent, because a whitespace-only REDIS_URL or webhook
 *  URL is a misconfiguration, not a usable value, and the call sites that
 *  previously used `||` treated it exactly this way. */
const trimmed = (env: NodeJS.ProcessEnv, key: string): EnvString => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/**
 * The codebase's boolean idiom, `=== 'true'`, applied to the trimmed value.
 *
 * Strictly `true`/`false` and nothing else. `'TRUE'`, `'1'`, `'yes'` and
 * `'on'` are all false, because that is what every `X_ENABLED === 'true'` in
 * this codebase has always meant and loosening it would silently enable
 * features on a host where the operator meant them off. The trim is the one
 * liberty taken: `' true '` is true, where inline it was false. Nobody sets
 * that.
 */
const boolFlag = (env: NodeJS.ProcessEnv, key: string): boolean => env[key]?.trim() === 'true';

/** A finite number, or undefined when absent, blank, or unparseable.
 *  `Number('abc')` is NaN and NaN silently poisons arithmetic downstream, so
 *  "present but garbage" and "absent" are deliberately the same answer here -
 *  the caller supplies the default either way. */
const finiteNumber = (env: NodeJS.ProcessEnv, key: string): EnvCount => {
  const raw = trimmed(env, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * FFMPEG_PATH - path to the ffmpeg binary, or undefined to let the caller fall
 * back to its own candidate list (`audioSignalService` tries the packaged
 * `ffmpeg-static` build and the usual Linux/Windows locations next).
 */
export function ffmpegPath(env: NodeJS.ProcessEnv = currentEnv()): BinaryPath {
  return trimmed(env, 'FFMPEG_PATH');
}

/** FFPROBE_PATH - path to the ffprobe binary, same fallback contract as
 *  {@link ffmpegPath}. */
export function ffprobePath(env: NodeJS.ProcessEnv = currentEnv()): BinaryPath {
  return trimmed(env, 'FFPROBE_PATH');
}

/**
 * The audio path write-back, which is a deliberate side effect and not a
 * leftover.
 *
 * `audioSignalService` resolves ffmpeg/ffprobe at import time - probing
 * FFMPEG_PATH, then two hardcoded locations, then the `ffmpeg-static` /
 * `ffprobe-static` packages - and publishes the winner back into
 * `process.env`. It has to, because the resolved path is not otherwise
 * reachable by the other consumer: `voiceMessageService.getDuration` hands
 * `get-audio-duration` a binary path read straight from the environment, and
 * on Windows `/usr/bin/ffprobe` does not exist, so without the write-back a
 * voice message falls back to a hardcoded 30s. Keeping the writes here rather
 * than inline at the call site is only cosmetic; what matters is that they
 * still happen, and that they happen BEFORE any `getDuration` call, which is
 * guaranteed by import-time resolution plus runtime use.
 *
 * A no-op for a blank input, so this can never write `''` over a good path.
 */
export function setFfmpegPath(value: string): void {
  const resolved = value.trim();
  if (resolved) process.env.FFMPEG_PATH = resolved;
}

/** The ffprobe half of the {@link setFfmpegPath} write-back. */
export function setFfprobePath(value: string): void {
  const resolved = value.trim();
  if (resolved) process.env.FFPROBE_PATH = resolved;
}

/**
 * REDIS_URL - the explicitly configured Redis address, or undefined when the
 * operator set none.
 *
 * NOTE this is NOT `ConfigData.Data.redis.url`, which defaults to
 * `redis://localhost:6379`. `CacheService` uses this accessor for a different
 * question - "was Redis configured at all?" - because a local default that
 * nothing is listening on is a connection error every boot, and the cache is
 * designed to run in-memory instead. Do not conflate the two.
 */
export function redisUrl(env: NodeJS.ProcessEnv = currentEnv()): EnvString {
  return trimmed(env, 'REDIS_URL');
}

/**
 * ERROR_WEBHOOK_URL - the Discord webhook that receives fatal errors, or
 * undefined when unconfigured. Undefined is the quiet no-op case, never an
 * error: this runs from `uncaughtException` handlers, where throwing would
 * replace a reported crash with an unreported one.
 */
export function errorWebhookUrl(env: NodeJS.ProcessEnv = currentEnv()): EnvString {
  return trimmed(env, 'ERROR_WEBHOOK_URL');
}

/**
 * SHARDING_ENABLED as a tri-state, NOT a boolean. See {@link ShardingFlag}.
 * 'true' wins, 'false' wins, and an absent/unrecognised value defers to
 * {@link shardCount}.
 */
export function shardingEnabledFlag(env: NodeJS.ProcessEnv = currentEnv()): ShardingFlag {
  const value = env.SHARDING_ENABLED?.trim();
  if (value === 'true' || value === 'false') return value;
  return undefined;
}

/** SHARD_COUNT, or undefined when absent, blank or unparseable. */
export function shardCount(env: NodeJS.ProcessEnv = currentEnv()): EnvCount {
  return finiteNumber(env, 'SHARD_COUNT');
}

/**
 * SKIP_SLASH_REGISTER - set to exactly 'true' to skip the global slash-command
 * PUT at boot. Used by dev and by shard workers, which must not race shard 0
 * for the global command list.
 */
export function skipSlashRegister(env: NodeJS.ProcessEnv = currentEnv()): boolean {
  return boolFlag(env, 'SKIP_SLASH_REGISTER');
}

/**
 * The health server's listening port: HEALTH_PORT, else PORT, else `fallback`.
 *
 * The precedence is `||` semantics preserved exactly, including the two places
 * that matters: an empty or whitespace-only HEALTH_PORT falls THROUGH to PORT
 * rather than being parsed as 0, and `'0'` is a real port (Node's "pick a free
 * one"), not a falsy string.
 *
 * The one intentional departure from the old inline
 * `Number(process.env.HEALTH_PORT || process.env.PORT || port)` is malformed
 * input. `Number('abc')` is NaN, and NaN went straight into
 * `server.listen(NaN)`, which throws ERR_SOCKET_BAD_PORT - so a typo in
 * HEALTH_PORT took down the health endpoint at boot. Out-of-range and
 * fractional values are rejected on the same grounds. A rejected value yields
 * `fallback`, which is the port the caller asked for, so the health endpoint
 * comes up somewhere reachable instead of nowhere.
 */
export function healthPort(fallback: number, env: NodeJS.ProcessEnv = currentEnv()): number {
  const raw = trimmed(env, 'HEALTH_PORT') ?? trimmed(env, 'PORT');
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_TCP_PORT) return fallback;
  return parsed;
}

/**
 * API_FOOTBALL_KEY - the API-Football key, or '' when unconfigured.
 *
 * '' rather than undefined because the call site's contract is
 * `isConfigured()`, and '' is what `|| ''` produced. An unconfigured provider
 * returns an empty fixture list rather than throwing, which is what keeps the
 * football commands alive for everyone who has not bought a subscription.
 */
export function apiFootballKey(env: NodeJS.ProcessEnv = currentEnv()): string {
  return trimmed(env, 'API_FOOTBALL_KEY') ?? '';
}

/**
 * ENVIRONMENT, untrimmed, defaulting to 'local'.
 *
 * `?? 'local'` not `|| 'local'`: an explicitly empty ENVIRONMENT is what the
 * disabled-Lavalink startup log interpolates verbatim, and `||` would have
 * printed 'local' where the old code printed ''. Not trimmed for the same
 * reason - the value is interpolated into a log line as-is.
 *
 * Lives here rather than in `musicEnv` because it is not music-specific: the
 * logger, puppeteer and the music resolver all read it. `musicEnv` re-exports it
 * so those call sites did not have to change.
 */
export function runtimeEnvironment(env: NodeJS.ProcessEnv = currentEnv()): string {
  return env.ENVIRONMENT ?? 'local';
}

/**
 * True when ENVIRONMENT or NODE_ENV is exactly 'production'.
 *
 * Two keys, not one: this repo sets ENVIRONMENT and Node sets NODE_ENV, and
 * which one is populated differs between the Railway deploy and a local run.
 * A single-key check silently disabled the production-only behaviour wherever
 * the other key was the one set.
 */
export function isProduction(env: NodeJS.ProcessEnv = currentEnv()): boolean {
  return env.ENVIRONMENT === 'production' || env.NODE_ENV === 'production';
}

/**
 * PUPPETEER_EXECUTABLE_PATH, trimmed. Undefined means "let Puppeteer find its
 * own bundled Chromium", which is the normal case.
 */
export function puppeteerExecutablePath(env: NodeJS.ProcessEnv = currentEnv()): EnvString {
  return trimmed(env, 'PUPPETEER_EXECUTABLE_PATH');
}

/**
 * LOG_LEVEL === 'debug' || ENVIRONMENT === 'local'.
 *
 * This is the opt-in for debug logging and it is deliberately NOT
 * `NODE_ENV !== 'production'`: nothing sets NODE_ENV in the deploy env (only
 * ENVIRONMENT), so the Node-shaped test was true in production and every one of
 * the ~80 debug call sites paid util.format + inspect + a synchronous disk
 * append on the hot path for logs nobody reads.
 */
export function isDebugLogging(env: NodeJS.ProcessEnv = currentEnv()): boolean {
  return env.LOG_LEVEL === 'debug' || (env.ENVIRONMENT ?? 'local') === 'local';
}

/**
 * LOG_FILE !== 'false' && NODE_ENV !== 'test' - file logging on by default.
 *
 * The NODE_ENV !== 'test' half stops the suite writing log files, which is why
 * a missing NODE_ENV here is a behaviour change, not a neutral default.
 */
export function isFileLoggingEnabled(env: NodeJS.ProcessEnv = currentEnv()): boolean {
  return env.LOG_FILE !== 'false' && env.NODE_ENV !== 'test';
}

/** NODE_ENV, or 'development' for the startup banner. `||` not `??`: unchanged. */
export function displayNodeEnv(env: NodeJS.ProcessEnv = currentEnv()): string {
  return env.NODE_ENV || 'development';
}
