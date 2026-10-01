/**
 * Validated accessors for the environment variables the MUSIC module reads.
 *
 * WHY THIS FILE IS ITS OWN THING
 * -----------------------------
 * `configData.ts` and `lavalink.ts` are off limits to this pass, and neither
 * fits: `configData` is a boot-time singleton whose lazy `Data` getter runs
 * `assertValidEnvironment()` and throws on a missing token, so importing it
 * from a leaf music module would make every music unit test depend on
 * developer secrets (the exact trap `src/testSupport/setupEnv.ts` documents).
 * `lavalink.ts` owns the NODE POOL, not the playback knobs. So the eight
 * keys below live here.
 *
 * THE FIDELITY CONTRACT — read before "improving" a parse
 * -------------------------------------------------------
 * Every getter reproduces the semantics of the `process.env.X` expression it
 * replaced, character for character, because a config refactor that changes
 * behaviour is a bug wearing a refactor's clothes. That is why some getters
 * deliberately do NOT trim and deliberately treat a blank value as set:
 *
 *   - `runtimeEnvironment` / `homeResolverUrl` / `homeResolverToken` return
 *     the RAW value. `resolverEnabled()` tested `!!process.env.HOME_RESOLVER_URL`,
 *     which is TRUE for `'   '`; trimming here would silently disable the
 *     whole resolver rung. The disabled-Lavalink log line also interpolates
 *     ENVIRONMENT verbatim, so trimming would change an operator-facing line.
 *   - `homeResolverUrl` / `homeResolverToken` return `undefined` rather than
 *     `''`, because the old `as string` casts relied on the nullish
 *     distinction only via the `resolverEnabled()` guard ahead of them.
 *   - `resolverAlertWebhookUrl` / `youtubeDataApiKey` DO trim, because the
 *     call sites already did `(x ?? '').trim()` and the trailing `.trim()` was
 *     load-bearing: a whitespace-only key must read as "not configured".
 *   - `homeLadderMode` / `homePluginRung` do NOT trim, because the old code
 *     was a strict `===` against a literal, and `' plugin-first-test '` was
 *     therefore OFF. Trimming would turn it on.
 *
 * There is deliberately no `import 'dotenv/config'` here. The music files
 * read `process.env` at call time today, and dotenv is loaded by the entry
 * graph; adding it would change which values they see, not how they read them.
 *
 * EVERY READ IS LAZY. None of the eight call sites read `process.env` at module
 * scope, so caching any of this at import time would be a behaviour change —
 * `moonlinkManager.test.ts` mutates `ENVIRONMENT` between constructions and
 * `ytResolver.test.ts` toggles `RESOLVER_ALERT_WEBHOOK_URL` mid-run.
 */

/**
 * `HOME_LADDER_MODE` — which rung order the Home node's search ladder uses.
 * `'resolver-first'` is the proven default; the other value is a trial rung.
 * Any unrecognised value (including blank) resolves to the safe default,
 * which is what the old bare `=== 'plugin-first-test'` did implicitly.
 */
export type HomeLadderMode = 'resolver-first' | 'plugin-first-test';

/**
 * `HOME_PLUGIN_RUNG` — whether Home participates in the YouTube-plugin rung.
 * Default `'off'`: the rung has never produced audio, and each attempt costs
 * ~2s of dead air. Collapses any unrecognised value to the default.
 */
export type HomePluginRung = 'on' | 'off';

/**
 * `ENABLE_LAVALINK` — explicit operator intent, as a tri-state rather than a
 * boolean. The flag is NOT `Boolean(x)`: `'false'` disables music even in
 * production, `'true'` enables it even locally, and anything else defers to
 * the environment. Collapsing that to two states would lose the distinction,
 * so unknown values become `'unset'`, which the call site reads exactly as it
 * read the old raw string.
 *
 * `''` is in the union for one reason: an operator who blanks the var
 * (`ENABLE_LAVALINK=`) got an EMPTY value in the disabled-path log line
 * before, because the site interpolated `flag ?? 'unset'`. Carrying the blank
 * state keeps that line byte-identical. It is safe to compare against —
 * `''` is neither `'true'` nor `'false'`, so it defers to the environment,
 * exactly as the raw empty string did — but do not use it in a truthiness
 * test; use the two literal comparisons.
 */
export type LavalinkEnableFlag = 'true' | 'false' | '' | 'unset';

/**
 * Private webhook for resolver-breakage alerts (502-rate and
 * PC-unreachable). Unset or blank = silent. Trimmed because the call site
 * already trimmed and treated the result as a usable URL.
 */
export const resolverAlertWebhookUrl = (): string =>
  (process.env.RESOLVER_ALERT_WEBHOOK_URL ?? '').trim();

/**
 * Home PC's yt-dlp resolver base URL. Raw and possibly blank: `resolverEnabled()`
 * only asks whether it is set at all, and blank IS set to that check. Callers
 * that build a request must sit behind that guard, exactly as before.
 */
export const homeResolverUrl = (): string | undefined => process.env.HOME_RESOLVER_URL;

/** Home resolver bearer token. Raw for the same reason as `homeResolverUrl`. */
export const homeResolverToken = (): string | undefined => process.env.HOME_RESOLVER_TOKEN;

/** `HOME_LADDER_MODE` as a validated union; unrecognised values are the default. */
export const homeLadderMode = (): HomeLadderMode =>
  process.env.HOME_LADDER_MODE === 'plugin-first-test' ? 'plugin-first-test' : 'resolver-first';

/** `HOME_PLUGIN_RUNG` as a validated union; unrecognised values are `'off'`. */
export const homePluginRung = (): HomePluginRung => (process.env.HOME_PLUGIN_RUNG === 'on' ? 'on' : 'off');

/**
 * `ENVIRONMENT`, defaulting to `'local'`. NOT trimmed: a blank or padded
 * value is not `'local'`, which is what enabled Lavalink outside production
 * before, and the disabled-path log line prints this value verbatim.
 *
 * The implementation moved to `runtimeEnv` because ENVIRONMENT is read by the
 * logger and puppeteer too - it is not music-specific. Re-exported here so the
 * four music call sites keep importing it from the module they already used.
 */
export { runtimeEnvironment } from '@config/runtimeEnv';

/**
 * `ENABLE_LAVALINK` as a validated tri-state. Only the two documented literals
 * survive; a present-but-blank value stays `''` and everything else — unset,
 * whitespace, typos — becomes `'unset'`. Both defer to the environment, so the
 * caller's `=== 'true'` / `=== 'false'` comparisons behave as they did.
 */
export const lavalinkEnableFlag = (): LavalinkEnableFlag => {
  const raw = process.env.ENABLE_LAVALINK;
  if (raw === 'true' || raw === 'false' || raw === '') return raw;
  return 'unset';
};

/**
 * YouTube Data API key used for the description-chapter probe. Trimmed, and
 * `''` when unset or blank — the probe treats a blank key as "unconfigured"
 * and returns null rather than calling the API with whitespace.
 */
export const youtubeDataApiKey = (): string => (process.env.YOUTUBE_API_KEY ?? '').trim();
