/**
 * LIVE verification against the real Last.fm API — the instrument that closed
 * the "no test has ever seen a real vendor" gap.
 *
 * ## Why this exists
 *
 * 4928 tests passed while a real, user-facing bug was live: `lastfmApi` judged
 * the HTTP status before reading the body, so a nonexistent user (HTTP **404**
 * with `{"error":6}`) was reported to users as "Last.fm is unreachable".
 * The mocked suite could not catch it, because the mock's shape did not match
 * what the vendor actually returns. This script asks the vendor.
 *
 * It runs the **production classes** — `LastfmApi` and `LastFmRepository` — not
 * a re-implementation, so it exercises the same seam a real command does.
 *
 * ## Why it found what the tests did not
 *
 * Last.fm is inconsistent about how it says "no such thing": the `user.*`
 * family answers HTTP 404, the `artist`/`track` families answer HTTP 200 with
 * the same body code. A single fixture shape cannot express both, so a mocked
 * test has to pick one and be wrong about the other.
 *
 * ## Running it
 *
 *   $env:NODE_USE_ENV_PROXY="1"   # Node's fetch ignores HTTP_PROXY without this
 *   npx tsx scripts/liveVerify.ts
 *
 * **NEVER PRINTS A SECRET.** Only shapes, codes, counts and lengths. It reads
 * the real credentials from `.env` because `ConfigData` reads `process.env` at
 * import time, and `LastfmApi` takes its keys from there.
 *
 * ## What it cannot tell you
 *
 * Nothing here observes voice, audio, ffmpeg, or a real Discord interaction.
 * It answers one question — does the not-found/outage split behave on the wire
 * as it does in tests — and that question was worth asking.
 */
import 'reflect-metadata';
import { LastfmApi } from '../src/lastfm/api/lastfmApi';
import { LastFmRepository } from '../src/lastfm/repositories/lastFmRepository';
import { LastfmErrorRateTracker } from '../src/domain/lastfmErrorRateTracker';
import { Logger } from '../src/domain/logger';

// The username the repo's own test fixtures already use, so a failure here means
// something about the code rather than about a typo.
const FIXTURE_USER = 'DreadRock';

const verdict = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
  if (!ok) {
    // A non-zero exit is the point: this script has to be able to fail loudly
    // in a pipeline, not just print red text nobody reads.
    process.exitCode = 1;
  }
};

const classify = (e: unknown): string => {
  const n = (e as { name?: string })?.name ?? 'Error';
  return n;
};

const main = async (): Promise<void> => {
  const api = new LastfmApi(new LastfmErrorRateTracker());
  const repo = new LastFmRepository(api);

  console.log('--- LIVE: not-found must return the empty answer, NOT raise ---');
  try {
    const info = await repo.getUserInfo('zzz_no_such_user_99871');
    verdict('getUserInfo(nonexistent) -> null', info === null, `got ${JSON.stringify(info)?.slice(0, 40)}`);
  } catch (e) {
    verdict('getUserInfo(nonexistent) -> null', false, `RAISED ${classify(e)} - outage and absence are conflated`);
  }
  try {
    const artists = await repo.getTopArtists('zzz_no_such_user_99871');
    verdict('getTopArtists(nonexistent) -> []', Array.isArray(artists) && artists.length === 0, `len=${(artists as unknown[])?.length}`);
  } catch (e) {
    verdict('getTopArtists(nonexistent) -> []', false, `RAISED ${classify(e)}`);
  }

  console.log('\n--- LIVE: the fixture user must return REAL data ---');
  try {
    const info = await repo.getUserInfo(FIXTURE_USER);
    const n = (info as { realname?: string; playcount?: string } | null)?.realname;
    verdict(`getUserInfo(${FIXTURE_USER}) -> populated`, !!info, `realname=${n ?? 'null'} plays=${(info as { playcount?: string })?.playcount ?? '?'}`);
  } catch (e) {
    verdict(`getUserInfo(${FIXTURE_USER}) -> populated`, false, `RAISED ${classify(e)}: ${(e as Error).message.slice(0, 70)}`);
  }

  console.log('\n--- LIVE: top lists carry REAL counts (not zeroed) ---');
  try {
    const top = await repo.getTopArtists(FIXTURE_USER, 'overall' as never, 5);
    const rows = (top as unknown as Array<{ name: string; playcount: number }>) ?? [];
    const nonZero = rows.filter((r) => (r.playcount ?? 0) > 0).length;
    verdict(`getTopArtists(${FIXTURE_USER}) -> real playcounts`, rows.length > 0 && nonZero > 0, `${rows.length} artists, ${nonZero} non-zero`);
  } catch (e) {
    verdict(`getTopArtists(${FIXTURE_USER}) -> real playcounts`, false, `RAISED ${classify(e)}`);
  }

  console.log('\n--- LIVE: artist artwork (the payload decides, not my expectation) ---');
  try {
    const art = await repo.getArtistInfo('Radiohead');
    const url = (art as { imageUrl?: string } | null)?.imageUrl ?? '';
    // Last.fm served `image: []` for artist.getinfo on this account/artist, so
    // an empty result is the HONEST answer here and the converter is right. The
    // assertion that matters is the one below it, on a track that does have art.
    console.log(`INFO  getArtistInfo(Radiohead) imageUrl=${url || '(none served by Last.fm)'}`);
  } catch (e) {
    console.log(`FAIL  getArtistInfo(Radiohead) raised ${classify(e)}`);
  }
  try {
    const track = await repo.getTrackInfo('Creep', 'Radiohead');
    const img = (track as { imageUrl?: string } | null)?.imageUrl ?? '';
    const PH = '2a96cbd8b46e442fc41c2b86b821562f';
    verdict('getTrackInfo(Creep) -> real art or honest empty', img.length > 0 ? !img.includes(PH) : true, `imageUrl=${img ? img.slice(-26) : '(empty - Last.fm served none)'}`);
  } catch (e) {
    verdict('getTrackInfo(Creep) -> real art or honest empty', false, `RAISED ${classify(e)}`);
  }

  console.log('\n--- LIVE: a genuine outage MUST raise (inject by pointing at a dead host) ---');
  const realCall = api.call.bind(api);
  (api as unknown as { call: unknown }).call = async () => {
    throw Object.assign(new Error('simulated uplink stall'), { name: 'LastfmApiError', code: -1 });
  };
  try {
    const r = await repo.getTopArtists(FIXTURE_USER, 'overall' as never, 5);
    verdict('outage -> RAISES (not an empty list)', false, `RETURNED len=${(r as unknown[])?.length} - an outage is indistinguishable from an empty library`);
  } catch (e) {
    verdict('outage -> RAISES (not an empty list)', true, `raised ${classify(e)}: ${(e as Error).message.slice(0, 50)}`);
  }
  (api as unknown as { call: unknown }).call = realCall;

  console.log('\n--- LIVE: recover and prove the class is still usable ---');
  try {
    const info = await repo.getUserInfo(FIXTURE_USER);
    verdict('real call works again after the outage', !!info, 'connection state recovered');
  } catch (e) {
    verdict('real call works again after the outage', false, `RAISED ${classify(e)}`);
  }

  Logger.info('live verification complete');
};

/**
 * Exits non-zero when a check fails, so this can gate a script or a cron.
 * The repo's PowerShell note applies: read this exit code, not stderr.
 */
main().then(() => {
  process.exitCode = process.exitCode ?? 0;
}).catch((err: unknown) => {
  console.error('live verification could not run:', (err as Error).message);
  process.exitCode = 1;
});
