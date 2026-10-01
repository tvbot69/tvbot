import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@domain/logger';
import { fetchDescriptionChapters, parseTimestampLines, __resetDescriptionChaptersForTests } from '@bot/services/music/descriptionChapters';

const SAVED_KEY = process.env.YOUTUBE_API_KEY;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

const notOk = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

const desc = (description: string) => ok({ items: [{ snippet: { description } }] });

/**
 * The Data API's answer to a revoked key, as MEASURED with a real bad key
 * (HTTP 400). Kept verbatim in the test so the detector cannot be "fixed" to
 * match a shape nobody has seen.
 */
const KEY_REJECTED = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    errors: [{ message: 'API key not valid. Please pass a valid API key.', domain: 'global', reason: 'badRequest' }],
    status: 'INVALID_ARGUMENT',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
    ],
  },
};

/** The shorter body that was also observed: status + message, no details. */
const KEY_REJECTED_SHORT = {
  error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' },
};

const stubFetch = (impl: () => unknown): string[] => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: unknown) => {
    calls.push(String(url));
    return Promise.resolve(impl());
  });
  return calls;
};

const setKey = (key?: string) => {
  if (key === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = key;
};

describe('parseTimestampLines', () => {
  it('parses m:ss and h:mm:ss with common separators and sorts', () => {
    expect(
      parseTimestampLines(
        [
          'Some Set',
          '',
          '17:00 - RockWave',
          '0:00 - Rottweiler',
          '1:02:03 Closer',
          '(2:30) 4 Raws',
          '[5:55] Century',
          '- 8:40 Panic',
          '00:00 Intro',
        ].join('\n'),
      ),
    ).toEqual([
      // "0:00 - Rottweiler" and "00:00 Intro" share a timestamp. Both used to
      // survive, and the LAST one won the boundary — so the card showed
      // "Intro" and masked the actual opening song for its full duration. The
      // real song name now wins over a generic container title.
      { title: 'Rottweiler', startMs: 0 },
      { title: '4 Raws', startMs: 150_000 },
      { title: 'Century', startMs: 355_000 },
      { title: 'Panic', startMs: 520_000 },
      { title: 'RockWave', startMs: 1_020_000 },
      { title: 'Closer', startMs: 3_723_000 },
    ]);
  });

  it('keeps a real song when a generic title is listed at the same timestamp', () => {
    const chapters = parseTimestampLines(['0:00 - Rottweiler', '00:00 Intro', '2:30 Outro'].join('\n'));
    expect(chapters).toEqual([
      { title: 'Rottweiler', startMs: 0 },
      { title: 'Outro', startMs: 150_000 },
    ]);
  });

  it('keeps distinct chapters that are genuinely close together', () => {
    // 5s apart is a real (if abrupt) track change, not a duplicate listing.
    const chapters = parseTimestampLines(['0:00 - Rottweiler', '0:05 - 4 Raws'].join('\n'));
    expect(chapters).toHaveLength(2);
  });

  it('falls back to a numbered title when the line is timestamp-only', () => {
    expect(parseTimestampLines('0:00\n1:30')).toEqual([
      { title: 'Chapter 1', startMs: 0 },
      { title: 'Chapter 2', startMs: 90_000 },
    ]);
  });

  it('ignores prose that merely mentions a time', () => {
    expect(parseTimestampLines('doors open at 17:00 sharp\nout now everywhere')).toEqual([]);
  });

  it('parses title-first lines ("INTRO - 00:00") used by live/DJ descriptions', () => {
    expect(
      parseTimestampLines(
        [
          'TRAVIS SCOTT LIVE - THE TOWN FESTIVAL 2025 (FULL SET)',
          '',
          'TIMESTAMPS:',
          '',
          'INTRO - 00:00',
          'CHAMPAIN & VACAY - 00:20',
          'UPPER ECHELON - 21:52 ',
          'FE!N (X2) - 43:00',
          'TELEKINESIS - 51:34',
        ].join('\n'),
      ),
    ).toEqual([
      { title: 'INTRO', startMs: 0 },
      { title: 'CHAMPAIN & VACAY', startMs: 20_000 },
      { title: 'UPPER ECHELON', startMs: 1_312_000 },
      { title: 'FE!N (X2)', startMs: 2_580_000 },
      { title: 'TELEKINESIS', startMs: 3_094_000 },
    ]);
  });

  it('keeps full titles containing dashes and accepts dash variants and pipes', () => {
    expect(parseTimestampLines('A - B - 1:00\nC | 2:30\nD – 3:00')).toEqual([
      { title: 'A - B', startMs: 60_000 },
      { title: 'C', startMs: 150_000 },
      { title: 'D', startMs: 180_000 },
    ]);
  });

  it('parses mixed leading and trailing formats in one description', () => {
    expect(parseTimestampLines('0:00 - Opener\nMid - 5:00\n1:02:03 - Closer')).toEqual([
      { title: 'Opener', startMs: 0 },
      { title: 'Mid', startMs: 300_000 },
      { title: 'Closer', startMs: 3_723_000 },
    ]);
  });

  it('does not treat colon-prose or trailing-text lines as chapters', () => {
    expect(parseTimestampLines('Premiere: 21:00\nupdated - see pinned comment\nSet: 1:30 (live)')).toEqual([]);
  });
});

describe('fetchDescriptionChapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDescriptionChaptersForTests();
    setKey('test-key');
  });

  afterEach(() => {
    setKey(SAVED_KEY);
    vi.unstubAllGlobals();
  });

  it('calls the Data API and maps description timestamps', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(desc('EsDeeKid Live\n\n0:00 - Rottweiler\n2:30 - 4 Raws\n1:02:03 - Closer'));
    await expect(fetchDescriptionChapters('dQw4w9WgXcQ')).resolves.toEqual([
      { title: 'Rottweiler', startMs: 0 },
      { title: '4 Raws', startMs: 150_000 },
      { title: 'Closer', startMs: 3_723_000 },
    ]);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.hostname).toBe('www.googleapis.com');
    expect(url.pathname).toBe('/youtube/v3/videos');
    expect(url.searchParams.get('id')).toBe('dQw4w9WgXcQ');
    expect(url.searchParams.get('part')).toBe('snippet');
  });

  it('serves the second call from cache with a single fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(desc('0:00 A\n1:00 B'));
    await fetchDescriptionChapters('cache0Hit00');
    await expect(fetchDescriptionChapters('cache0Hit00')).resolves.toEqual([
      { title: 'A', startMs: 0 },
      { title: 'B', startMs: 60_000 },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('negative-caches API failures for 10 minutes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(fetchDescriptionChapters('api0fail000')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('api0fail000')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('negative-caches missing videos (empty items)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ items: [] }));
    await expect(fetchDescriptionChapters('gone0video0')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('gone0video0')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns [] (cached) when the description has no timestamp lines', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(desc('no chapters here\njust lyrics'));
    await expect(fetchDescriptionChapters('no0stamp000')).resolves.toEqual([]);
    await expect(fetchDescriptionChapters('no0stamp000')).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null without fetching when no key is configured', async () => {
    setKey(undefined);
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchDescriptionChapters('dQw4w9WgXcQ')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects invalid video ids without any fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchDescriptionChapters('short')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * A DEAD CREDENTIAL is a different failure from a video that cannot answer,
 * and the difference has to be visible in the logs. Before this block, a
 * revoked, expired or typo'd key, a 400, and a deleted video all produced one
 * `null` and one DEBUG line — and DEBUG is gated on DEBUG_LOGGING, so in
 * production the whole chapter feature was silently off forever.
 */
describe('fetchDescriptionChapters — a dead YouTube API key', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDescriptionChaptersForTests();
    setKey('test-key');
  });

  afterEach(() => {
    setKey(SAVED_KEY);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('treats a 400 credential rejection as a lost capability: WARN, with the reason', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    stubFetch(() => notOk(400, KEY_REJECTED));

    await expect(fetchDescriptionChapters('bad0key0000')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0]!;
    expect(String(message)).toContain('DISABLED');
    expect((context as { reason?: string }).reason).toBe('API_KEY_INVALID');
    // The same line at DEBUG would be invisible in Railway, which is the whole
    // defect: the credential is the only thing that can be repaired, and only
    // the operator can repair it.
    expect(debug).not.toHaveBeenCalled();
  });

  it('does not re-probe the API for the next video while the credential is dead', async () => {
    const vi1 = stubFetch(() => notOk(400, KEY_REJECTED));
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    await expect(fetchDescriptionChapters('bad0key0000')).resolves.toBeNull();
    // A different video, so the only thing that can answer this without a
    // request is the credential latch. A per-video 10-minute negative entry
    // cannot: the fault is not a property of `bad0key0000`, and the second id
    // has never been asked.
    await expect(fetchDescriptionChapters('bad0key0001')).resolves.toBeNull();

    expect(vi1).toHaveLength(1);
  });

  it('does not repeat the WARN for every video while the key stays broken', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch(() => notOk(400, KEY_REJECTED));

    for (const id of ['warn0once00', 'warn0once01', 'warn0once02', 'warn0once03']) {
      await expect(fetchDescriptionChapters(id)).resolves.toBeNull();
    }

    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the latch lapses instead of serving a 10-minute negative', async () => {
    // Only `Date` is faked, so nothing else about the probe changes and the
    // assertions below are about the TTL windows and nothing else.
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch(() => notOk(400, KEY_REJECTED));

    await expect(fetchDescriptionChapters('latch0expir')).resolves.toBeNull();
    expect(calls).toHaveLength(1);

    // Past BOTH the 1-hour credential latch and the 10-minute negative cache.
    // If the credential fault had also written `negCache`, the second call
    // would be answered by the negative cache and never reach the API, and
    // that entry would then re-arm every 10 minutes for the life of the
    // process — the exact loop this fix exists to stop.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await expect(fetchDescriptionChapters('latch0expir')).resolves.toBeNull();

    expect(calls).toHaveLength(2);
    // A WARN per latch window, not per probe.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('recognises the shorter status+message body for the same rejection', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    stubFetch(() => notOk(400, KEY_REJECTED_SHORT));

    await expect(fetchDescriptionChapters('bad0key0000')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0]![0] as { reason?: string }).reason).toBe('API key not valid.');
  });

  it('treats an unset key as the same lost capability, without any fetch', async () => {
    setKey(undefined);
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch(() => notOk(400, KEY_REJECTED));

    await expect(fetchDescriptionChapters('nokey000000')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('nokey000001')).resolves.toBeNull();

    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0]![0] as { reason?: string }).reason).toBe('YOUTUBE_API_KEY is not set');
  });
});

/**
 * The other side of the same fix: an ordinary failure must still behave
 * EXACTLY as it did. Nothing here may latch, WARN, or lose its 10-minute
 * negative cache, and a good key must still be able to serve chapters after
 * one — the latch must not turn a transient failure into a permanent one.
 */
describe('fetchDescriptionChapters — ordinary failures are unchanged', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDescriptionChaptersForTests();
    setKey('test-key');
  });

  afterEach(() => {
    setKey(SAVED_KEY);
    vi.unstubAllGlobals();
  });

  it('keeps a 5xx on the ordinary 10-minute negative path, at DEBUG', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const calls = stubFetch(() => notOk(503, { error: { message: 'backend error' } }));

    await expect(fetchDescriptionChapters('five0xx0000')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('five0xx0000')).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not treat a 403 as a dead key, so a later good video still works', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    let first = true;
    const calls = stubFetch(() => {
      const response = first
        ? notOk(403, { error: { code: 403, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } })
        : desc('0:00 - A\n1:00 - B');
      first = false;
      return response;
    });

    await expect(fetchDescriptionChapters('quota0fail0')).resolves.toBeNull();
    // The latch must NOT have been set by a quota response, or a good key
    // would go dark for an hour on a condition that clears by itself.
    await expect(fetchDescriptionChapters('good0after0')).resolves.toEqual([
      { title: 'A', startMs: 0 },
      { title: 'B', startMs: 60_000 },
    ]);

    expect(calls).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not treat an unrecognised 400 as a dead key', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const calls = stubFetch(() => notOk(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value' } }));

    await expect(fetchDescriptionChapters('other0four0')).resolves.toBeNull();
    await expect(fetchDescriptionChapters('other0four0')).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The assertion that matters: chapters are decoration, and this promise is
 * awaited inside playback. Every one of these resolves. `resolves` fails the
 * test on a rejection, so a throw in any of these paths is a RED, not a
 * silent degradation.
 *
 * SCOPE: this block pins the code that reads a 400 body — the new `readJson`
 * and `credentialRejection` — against throwing. The transport-throw case (a
 * rejecting fetch, an aborted signal) is `probe`'s pre-existing catch, and it
 * is already pinned by "negative-caches API failures for 10 minutes"; both were
 * mutation-checked, and neither is duplicated here.
 */
describe('fetchDescriptionChapters — the failure path can never reject', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDescriptionChaptersForTests();
    setKey('test-key');
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setKey(SAVED_KEY);
    vi.unstubAllGlobals();
  });

  // Each test also asserts the fetch HAPPENED. A mistyped id (anything other
  // than 11 chars) is rejected by the guard before any request, which would
  // make a "can never reject" test pass without exercising the failure path.

  it('resolves when the 400 error body is not JSON at all', async () => {
    const calls = stubFetch(() => ({ ok: false, status: 400, json: async () => { throw new SyntaxError('Unexpected token'); } }) as unknown as Response);
    await expect(fetchDescriptionChapters('badjson0000')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('resolves when the 400 error body is a bare string', async () => {
    const calls = stubFetch(() => notOk(400, 'API key not valid.'));
    await expect(fetchDescriptionChapters('strbody0000')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('resolves when the 400 response carries no json method at all', async () => {
    const calls = stubFetch(() => ({ ok: false, status: 400 }) as unknown as Response);
    await expect(fetchDescriptionChapters('nojson00000')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('resolves when the credential body is a nested array', async () => {
    const calls = stubFetch(() => notOk(400, [KEY_REJECTED]));
    await expect(fetchDescriptionChapters('arraybody00')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('resolves when the error envelope details are not an array', async () => {
    const calls = stubFetch(() => notOk(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: 'nope', errors: 7 } }));
    await expect(fetchDescriptionChapters('badshape000')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});
