/**
 * Re-export shim. The real implementation moved to `src/config/configData.ts`.
 *
 * Config is a lower layer - `src/persistence`, `src/lastfm` and `src/spotify`
 * all read it - and it living under `src/bot/` meant those layers had to import
 * `@bot/*` to get a string out of the environment (plan 3.2).
 *
 * Eleven files still import this path. They are all in `src/bot/`, where it was
 * never a layering problem, and a mechanical rewrite of eleven working imports
 * buys nothing over a one-line re-export. Point new code at `@config/configData`.
 */
export { ConfigData } from '@config/configData';
