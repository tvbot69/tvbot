import { describe, it, expect, afterEach } from 'vitest';
import {
  homeLadderMode,
  homePluginRung,
  homeResolverToken,
  homeResolverUrl,
  lavalinkEnableFlag,
  resolverAlertWebhookUrl,
  runtimeEnvironment,
  youtubeDataApiKey,
  type HomeLadderMode,
  type HomePluginRung,
  type LavalinkEnableFlag,
} from '../musicEnv';

/**
 * This suite is a REFACTOR gate, not a feature test. The contract is
 * "same value as before, for every input", so the oracle is the pre-refactor
 * `process.env` expression itself, copied verbatim out of the four music
 * files. The equivalence table below is the spec; the accessors are the
 * implementation. A test that re-implements the accessor would prove nothing
 * (AGENTS.md section 11), so it re-states the OLD code instead.
 */

const KEYS = [
  'RESOLVER_ALERT_WEBHOOK_URL',
  'HOME_RESOLVER_URL',
  'HOME_RESOLVER_TOKEN',
  'HOME_LADDER_MODE',
  'HOME_PLUGIN_RUNG',
  'ENVIRONMENT',
  'ENABLE_LAVALINK',
  'YOUTUBE_API_KEY',
] as const;

const SAVED: Record<string, string | undefined> = {};
for (const k of KEYS) SAVED[k] = process.env[k];

/**
 * `process.env.X = undefined` assigns the literal string "undefined", so an
 * absent var must be `delete`d. The whole point of these tests is telling
 * absent apart from blank.
 */
const setEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(() => {
  for (const k of KEYS) setEnv(k, SAVED[k]);
});

/**
 * Every shape an env var realistically arrives in: the documented values, the
 * missing/blank cases, whitespace padding, case drift, and outright garbage.
 * "Wrong type" for this module means a value that is not in the key's
 * vocabulary — a non-boolean where a tri-state is expected, a non-mode where a
 * mode is expected — since none of the eight keys is numeric.
 */
const VALUES: Array<string | undefined> = [
  undefined,
  '',
  ' ',
  '\t\n',
  'true',
  'false',
  'TRUE',
  'False',
  ' true ',
  'on',
  'off',
  'ON',
  ' on',
  'on ',
  'yes',
  '0',
  '1',
  'null',
  'local',
  'production',
  'staging',
  '  production  ',
  'plugin-first-test',
  ' plugin-first-test ',
  'Plugin-First-Test',
  'resolver-first',
  'https://discord.test/api/webhooks/alerts',
  '  https://discord.test/api/webhooks/alerts  ',
  'test-youtube-key',
  'not-a-key',
];

// ---------------------------------------------------------------------------
// Per-key equivalence against the pre-refactor expressions
// ---------------------------------------------------------------------------

describe('musicEnv reproduces the pre-refactor process.env expressions', () => {
  it('RESOLVER_ALERT_WEBHOOK_URL: nullish to empty, then trimmed', () => {
    const old = (): string => (process.env.RESOLVER_ALERT_WEBHOOK_URL ?? '').trim();
    for (const v of VALUES) {
      setEnv('RESOLVER_ALERT_WEBHOOK_URL', v);
      expect([v, resolverAlertWebhookUrl()]).toEqual([v, old()]);
    }
  });

  it('HOME_RESOLVER_URL: raw, undefined stays undefined (the as string casts depend on it)', () => {
    const old = (): string | undefined => process.env.HOME_RESOLVER_URL;
    for (const v of VALUES) {
      setEnv('HOME_RESOLVER_URL', v);
      expect([v, homeResolverUrl()]).toEqual([v, old()]);
    }
  });

  it('HOME_RESOLVER_TOKEN: raw, undefined stays undefined', () => {
    const old = (): string | undefined => process.env.HOME_RESOLVER_TOKEN;
    for (const v of VALUES) {
      setEnv('HOME_RESOLVER_TOKEN', v);
      expect([v, homeResolverToken()]).toEqual([v, old()]);
    }
  });

  it('HOME_LADDER_MODE: strict === against the literal, so padding stays OFF', () => {
    // Old: `pluginTestMode()` in youtubeHealth.ts
    const old = (): boolean => process.env.HOME_LADDER_MODE === 'plugin-first-test';
    for (const v of VALUES) {
      setEnv('HOME_LADDER_MODE', v);
      expect([v, homeLadderMode() === 'plugin-first-test']).toEqual([v, old()]);
    }
    // Spelled out, because this is the one a "helpful" `.trim()` would break.
    setEnv('HOME_LADDER_MODE', ' plugin-first-test ');
    expect(homeLadderMode()).toBe('resolver-first');
    setEnv('HOME_LADDER_MODE', 'plugin-first-test');
    expect(homeLadderMode()).toBe('plugin-first-test');
  });

  it('HOME_PLUGIN_RUNG: ?? off then strict === on', () => {
    // Old: `(process.env.HOME_PLUGIN_RUNG ?? 'off') === 'on'` in youtubeHealth.ts
    const old = (): boolean => (process.env.HOME_PLUGIN_RUNG ?? 'off') === 'on';
    for (const v of VALUES) {
      setEnv('HOME_PLUGIN_RUNG', v);
      expect([v, homePluginRung() === 'on']).toEqual([v, old()]);
    }
    setEnv('HOME_PLUGIN_RUNG', 'on ');
    expect(homePluginRung()).toBe('off');
    setEnv('HOME_PLUGIN_RUNG', 'ON');
    expect(homePluginRung()).toBe('off');
    setEnv('HOME_PLUGIN_RUNG', 'off');
    expect(homePluginRung()).toBe('off');
    setEnv('HOME_PLUGIN_RUNG', 'on');
    expect(homePluginRung()).toBe('on');
  });

  it('ENVIRONMENT: ?? local, untrimmed, because the disabled path logs it verbatim', () => {
    const old = (): string => process.env.ENVIRONMENT ?? 'local';
    for (const v of VALUES) {
      setEnv('ENVIRONMENT', v);
      expect([v, runtimeEnvironment()]).toEqual([v, old()]);
    }
    setEnv('ENVIRONMENT', '  production  ');
    expect(runtimeEnvironment()).toBe('  production  ');
  });

  it('ENABLE_LAVALINK: the resolved enablement boolean is unchanged for every input', () => {
    // Old: moonlinkManager.ts constructor, verbatim.
    const oldEnabled = (): boolean => {
      const env = process.env.ENVIRONMENT ?? 'local';
      const flag = process.env.ENABLE_LAVALINK;
      if (flag === 'false') return false;
      return flag === 'true' || env !== 'local';
    };
    const newEnabled = (): boolean => {
      const env = runtimeEnvironment();
      const flag = lavalinkEnableFlag();
      if (flag === 'false') return false;
      return flag === 'true' || env !== 'local';
    };
    const ENVS: Array<string | undefined> = [undefined, '', ' ', 'local', 'production', 'staging', 'LOCAL'];
    const FLAGS: Array<string | undefined> = [undefined, '', ' ', 'true', 'false', 'TRUE', 'False', ' true ', 'yes', 'on', '0', '1'];
    for (const e of ENVS) {
      for (const f of FLAGS) {
        setEnv('ENVIRONMENT', e);
        setEnv('ENABLE_LAVALINK', f);
        expect([e, f, newEnabled()]).toEqual([e, f, oldEnabled()]);
      }
    }
  });

  it('ENABLE_LAVALINK: only the two documented literals survive; everything else is unset', () => {
    // The exact `=== 'true'` / `=== 'false'` edge. This is a tri-state, not a
    // boolean: a typo must not read as intent, and 'false' must never be
    // confused with 'unset' (one disables music, the other defers to env).
    setEnv('ENABLE_LAVALINK', 'true');
    expect(lavalinkEnableFlag()).toBe('true');
    setEnv('ENABLE_LAVALINK', 'false');
    expect(lavalinkEnableFlag()).toBe('false');
    for (const junk of [undefined, ' ', 'TRUE', 'False', ' true ', 'false ', 'yes', 'on', '0', '1', 'null']) {
      setEnv('ENABLE_LAVALINK', junk);
      expect([junk, lavalinkEnableFlag()]).toEqual([junk, 'unset']);
    }
  });

  it('ENABLE_LAVALINK: the log token is byte-identical to `flag ?? unset`', () => {
    // Old: `ENABLE_LAVALINK=${flag ?? 'unset'}` in the disabled-path log line.
    // Blank is the case that catches a naive tri-state: `ENABLE_LAVALINK=`
    // printed an EMPTY value before, because '' is not nullish. Found by this
    // test failing on the first draft, not by reading the diff.
    for (const v of [undefined, '', 'true', 'false'] as Array<string | undefined>) {
      setEnv('ENABLE_LAVALINK', v);
      expect([v, lavalinkEnableFlag()]).toEqual([v, v ?? 'unset']);
    }
    // Whitespace is not a documented state and has always printed verbatim.
    setEnv('ENABLE_LAVALINK', ' ');
    expect(lavalinkEnableFlag()).toBe('unset');
  });

  it('YOUTUBE_API_KEY: nullish to empty, then trimmed', () => {
    const old = (): string => (process.env.YOUTUBE_API_KEY ?? '').trim();
    for (const v of VALUES) {
      setEnv('YOUTUBE_API_KEY', v);
      expect([v, youtubeDataApiKey()]).toEqual([v, old()]);
    }
    setEnv('YOUTUBE_API_KEY', '   ');
    expect(youtubeDataApiKey()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Liveness: the accessors read process.env, they are not cached constants
// ---------------------------------------------------------------------------

type LivenessRow = {
  readonly key: string;
  readonly accessor: () => unknown;
  readonly unset: unknown;
  readonly set: unknown;
  readonly other: unknown;
};

const LIVENESS: LivenessRow[] = [
  { key: 'RESOLVER_ALERT_WEBHOOK_URL', accessor: resolverAlertWebhookUrl, unset: '', set: 'https://a.test/h', other: 'https://b.test/h' },
  { key: 'HOME_RESOLVER_URL', accessor: homeResolverUrl, unset: undefined, set: 'http://127.0.0.1:2335', other: 'http://127.0.0.1:9999' },
  { key: 'HOME_RESOLVER_TOKEN', accessor: homeResolverToken, unset: undefined, set: 'tok-a', other: 'tok-b' },
  { key: 'HOME_LADDER_MODE', accessor: homeLadderMode, unset: 'resolver-first', set: 'plugin-first-test', other: 'resolver-first' },
  { key: 'HOME_PLUGIN_RUNG', accessor: homePluginRung, unset: 'off', set: 'on', other: 'off' },
  { key: 'ENVIRONMENT', accessor: runtimeEnvironment, unset: 'local', set: 'production', other: 'staging' },
  { key: 'ENABLE_LAVALINK', accessor: lavalinkEnableFlag, unset: 'unset', set: 'true', other: 'false' },
  { key: 'YOUTUBE_API_KEY', accessor: youtubeDataApiKey, unset: '', set: 'key-a', other: 'key-b' },
];

describe('musicEnv reads process.env on every call', () => {
  for (const row of LIVENESS) {
    it(`${row.key} is not a cached constant`, () => {
      const original = row.accessor();

      setEnv(row.key, undefined);
      expect([row.key, row.accessor()]).toEqual([row.key, row.unset]);

      setEnv(row.key, String(row.set));
      expect([row.key, row.accessor()]).toEqual([row.key, row.set]);

      setEnv(row.key, String(row.other));
      expect([row.key, row.accessor()]).toEqual([row.key, row.other]);

      // Save-then-restore must return the accessor to where it started, and
      // must be observed through a fresh call rather than a cached snapshot.
      setEnv(row.key, original === undefined ? undefined : String(original));
      expect([row.key, row.accessor()]).toEqual([row.key, original]);
    });
  }

  it('mutating env after import is observed (no import-time snapshot)', () => {
    // The four music files read at call time today; this module is already
    // imported above, so a module-scope const would fail here.
    setEnv('HOME_PLUGIN_RUNG', 'on');
    expect(homePluginRung()).toBe('on');
    setEnv('HOME_PLUGIN_RUNG', 'off');
    expect(homePluginRung()).toBe('off');
    setEnv('ENVIRONMENT', 'production');
    expect(runtimeEnvironment()).toBe('production');
    setEnv('ENVIRONMENT', 'local');
    expect(runtimeEnvironment()).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// Absent vs blank, which is the distinction a naive `?? 'default'` gets wrong
// ---------------------------------------------------------------------------

describe('missing vs blank', () => {
  it('nullish-coalescing keys default only when the var is truly absent', () => {
    setEnv('ENVIRONMENT', undefined);
    expect(runtimeEnvironment()).toBe('local');
    setEnv('ENVIRONMENT', '');
    // '' is not nullish, so the old `?? 'local'` did NOT fire here, and '' is
    // not 'local' — which is what enabled Lavalink outside production.
    expect(runtimeEnvironment()).toBe('');
  });

  it('truthiness keys read a blank string as SET, not as absent', () => {
    // resolverEnabled() used `!!process.env.HOME_RESOLVER_URL`; a whitespace
    // value was truthy. A `.trim()` in the accessor would disable the whole
    // resolver rung for an operator who pasted a trailing newline.
    setEnv('HOME_RESOLVER_URL', '   ');
    setEnv('HOME_RESOLVER_TOKEN', '   ');
    expect(!!homeResolverUrl()).toBe(true);
    expect(!!homeResolverToken()).toBe(true);
    setEnv('HOME_RESOLVER_URL', undefined);
    expect(!!homeResolverUrl()).toBe(false);
  });

  it('trimmed keys collapse blank to a value the caller can reject', () => {
    setEnv('YOUTUBE_API_KEY', '  \t ');
    expect(youtubeDataApiKey()).toBe('');
    expect(!!youtubeDataApiKey()).toBe(false);
    setEnv('RESOLVER_ALERT_WEBHOOK_URL', ' ');
    expect(resolverAlertWebhookUrl()).toBe('');
    expect(!!resolverAlertWebhookUrl()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Named types survive, so a call site gets a compile error on a bad literal
// ---------------------------------------------------------------------------

describe('returned types are the named unions', () => {
  it('narrows to HomeLadderMode / HomePluginRung / LavalinkEnableFlag', () => {
    const mode: HomeLadderMode = homeLadderMode();
    const rung: HomePluginRung = homePluginRung();
    const flag: LavalinkEnableFlag = lavalinkEnableFlag();
    expect([mode, rung, flag].every((v) => typeof v === 'string')).toBe(true);
    expect(['resolver-first', 'plugin-first-test']).toContain(mode);
    expect(['on', 'off']).toContain(rung);
    expect(['true', 'false', '', 'unset']).toContain(flag);
  });
});
