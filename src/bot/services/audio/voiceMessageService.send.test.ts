import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `VoiceMessageService` — the two Discord upload paths for a preview voice
 * message (multipart webhook followup, and the three-step channel attachment
 * flow) plus the duration/waveform derivation they send alongside the audio.
 *
 * No real ffmpeg, no real Discord, no real audio. The probe layer is behind
 * `get-audio-duration` and the file reads are behind `fs/promises`, so both are
 * faked and every assertion is about WHAT THE SERVICE HANDS TO DISCORD — the
 * payload, the flags, the duration it claims, and the bytes it claims are a
 * waveform.
 *
 * The claim that matters most is the last one: this service cannot report a
 * waveform it could not produce, because it never produces one. See the
 * `the waveform it sends` describe.
 */

const { getAudioDurationInSeconds } = vi.hoisted(() => ({
  getAudioDurationInSeconds: vi.fn(async (..._args: unknown[]): Promise<number> => 12.5),
}));

const { readFile, stat, existsSync, ffprobePath, logger } = vi.hoisted(() => ({
  readFile: vi.fn(async (..._args: unknown[]): Promise<Buffer> => Buffer.from('ogg-bytes')),
  stat: vi.fn(async (..._args: unknown[]): Promise<{ size: number }> => ({ size: 4096 })),
  existsSync: vi.fn((..._args: unknown[]): boolean => false),
  ffprobePath: vi.fn((..._args: unknown[]): string | undefined => '/configured/ffprobe'),
  logger: {
    debug: vi.fn((..._args: unknown[]) => undefined),
    info: vi.fn((..._args: unknown[]) => undefined),
    warn: vi.fn((..._args: unknown[]) => undefined),
    error: vi.fn((..._args: unknown[]) => undefined),
  },
}));

vi.mock('get-audio-duration', () => ({ getAudioDurationInSeconds }));
vi.mock('fs/promises', () => ({ default: { readFile, stat } }));
vi.mock('fs', () => ({ default: { existsSync } }));
vi.mock('@config/runtimeEnv', () => ({ ffprobePath }));
vi.mock('@domain/logger', () => ({ Logger: logger }));

/** Fresh module per test, so the fs/runtimeEnv mocks attach to the instance
 *  under test rather than to a module graph cached by an earlier file. */
const load = async (): Promise<typeof import('./voiceMessageService')> => {
  vi.resetModules();
  return import('./voiceMessageService');
};

const OK = (body: unknown = { ok: true }): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });

type Route = {
  match: (url: string, init: RequestInit) => boolean;
  reply: (init: RequestInit) => Response | Promise<Response>;
};

const ATTACH_OK = {
  attachments: [{ upload_url: 'https://cdn.discordapp.com/attachments/v2', upload_filename: '42_voice.ogg' }],
};

/** The happy three-step channel route, so each test can override exactly one leg. */
const happyRoutes = (): Route[] => [
  { match: (u, i) => u.endsWith('/attachments') && i.method === 'POST', reply: () => OK(ATTACH_OK) },
  { match: (u) => u === 'https://cdn.discordapp.com/attachments/v2', reply: () => OK() },
  { match: (u, i) => u.includes('/messages') && i.method === 'POST', reply: () => OK({ id: 'm-1' }) },
];

/** Everything one fetch (the multipart body or the JSON body), typed at the
 *  call site so the assertions read like the payload they check. */
type Wire = {
  url: (n: number) => string;
  init: (n: number) => RequestInit;
  form: (n: number) => FormData;
  /** payload_json from the multipart body. */
  hook: (n: number) => Record<string, unknown>;
  /** JSON body of a plain (non-multipart) call. */
  json: (n: number) => Record<string, unknown>;
  attachment: (n: number) => Record<string, unknown>;
  hookAttachment: (n: number) => Record<string, unknown>;
  lastJsonAttachment: () => Record<string, unknown>;
  count: () => number;
  clear: () => void;
};

/**
 * Install the fetch double and hand back typed accessors. An unrouted URL
 * throws loudly rather than silently returning undefined, which is how a test
 * that hits an unexpected call fails loudly instead of half-passing.
 */
const installFetch = (routes: Route[]): Wire => {
  const double = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const args = init ?? {};
    const hit = routes.find((r) => r.match(String(input), args));
    if (!hit) throw new Error(`unrouted fetch: ${String(input)}`);
    return hit.reply(args);
  });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(double);

  const init = (n: number): RequestInit => (spy.mock.calls[n]?.[1] ?? {}) as RequestInit;
  const json = (n: number): Record<string, unknown> => JSON.parse(String(init(n).body)) as Record<string, unknown>;
  const form = (n: number): FormData => init(n).body as FormData;
  const attachment = (payload: Record<string, unknown>): Record<string, unknown> =>
    (payload.attachments as Record<string, unknown>[])[0]!;

  return {
    url: (n) => String(spy.mock.calls[n]?.[0]),
    init,
    form,
    json,
    hook: (n) => JSON.parse(form(n).get('payload_json') as string) as Record<string, unknown>,
    attachment: (n) => attachment(json(n)),
    hookAttachment: (n) => attachment(JSON.parse(form(n).get('payload_json') as string) as Record<string, unknown>),
    lastJsonAttachment: () => attachment(json(spy.mock.calls.length - 1)),
    count: () => spy.mock.calls.length,
    // The call log is per-file, so a second send in one test has to start at
    // index 0 again. `mockClear` empties the recorded calls WITHOUT touching
    // the implementation, so the route table installed above survives.
    clear: () => spy.mockClear(),
  };
};

/** Assign/restore by hand rather than `vi.spyOn(Math, …)`, so nothing here can
 *  leave a shared static stubbed for a later test. */
const realRandom = Math.random;
const stubRandom = (value: number): void => {
  Math.random = () => value;
};

beforeEach(() => {
  vi.clearAllMocks();
  getAudioDurationInSeconds.mockResolvedValue(12.5);
  readFile.mockResolvedValue(Buffer.from('ogg-bytes'));
  stat.mockResolvedValue({ size: 4096 });
  existsSync.mockReturnValue(false);
  ffprobePath.mockReturnValue('/configured/ffprobe');
});

afterEach(() => {
  Math.random = realRandom;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('VoiceMessageService.sendViaWebhook — the multipart followup', () => {
  const anyOk = (): Route[] => [{ match: () => true, reply: () => OK() }];

  it('POSTs to the webhook URL built from the app id and the interaction token', async () => {
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    expect(f.url(0)).toBe('https://discord.com/api/v10/webhooks/app-1/tok-1');
    expect(f.init(0).method).toBe('POST');
    expect((f.init(0).headers as Record<string, string>).Authorization).toBe('Bot bot-token');
  });

  it('sets the voice-message flag 8192, which is what makes Discord render a waveform', async () => {
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    // Without 8192 the attachment lands as a plain file and the card shows
    // nothing — the flag is the whole point of the payload_json leg.
    expect(f.hook(0).flags).toBe(8192);
  });

  it('uploads the audio bytes under the voice-message filename as an ogg blob', async () => {
    readFile.mockResolvedValue(Buffer.from([1, 2, 3, 4, 5]));
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    const file = f.form(0).getAll('files[0]')[0] as File;
    expect(file.name).toBe('voice-message.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    // The payload and the file must agree on the filename or Discord rejects
    // the whole attachment.
    expect(f.hookAttachment(0).filename).toBe('voice-message.ogg');
    expect(f.hookAttachment(0).id).toBe('0');
  });

  it('the duration it claims is the duration ffprobe read, not a constant', async () => {
    getAudioDurationInSeconds.mockResolvedValue(29.99);
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    expect(f.hookAttachment(0).duration_secs).toBe(29.99);
  });

  it('a duration ffprobe could not read falls back to 30s and is not sent as NaN', async () => {
    getAudioDurationInSeconds.mockResolvedValue(Number.NaN);
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    // NaN in a duration field is how Discord renders a voice message with no
    // waveform at all. 30 is a stated fallback, and it is the honest one.
    expect(f.hookAttachment(0).duration_secs).toBe(30);
  });

  it('a zero or negative duration is a fallback too, not a literal 0s voice message', async () => {
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();
    const svc = new VoiceMessageService();
    for (const bad of [0, -4]) {
      getAudioDurationInSeconds.mockResolvedValue(bad);
      // The spy is one per file, so the call log has to be reset per case or
      // the second iteration would re-assert the first one's payload.
      f.clear();
      await svc.sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');
      expect(f.hookAttachment(0).duration_secs).toBe(30);
    }
  });

  it('an ffprobe failure degrades to 30s and says so, instead of sending an unlabelled guess', async () => {
    // A1: the capability is lost, and the log names which one.
    getAudioDurationInSeconds.mockRejectedValue(new Error('ffprobe exited with code 1'));
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    expect(f.hookAttachment(0).duration_secs).toBe(30);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The log carries the real Error object as `err` (voiceMessageService.ts:73),
    // and `JSON.stringify` of an Error is `{}` — the message has to be read off
    // the object itself, which is also what the real logger inspects.
    const logged = logger.warn.mock.calls[0] as unknown[];
    expect(logged[0]).toMatchObject({ err: expect.any(Error) });
    expect((logged[0] as { err: Error }).err.message).toMatch(/ffprobe exited with code 1/);
    expect(String(logged[1])).toMatch(/Failed to get audio duration/);
  });

  it('bounds the call, so a stalled Discord cannot hang the interaction forever', async () => {
    const f = installFetch(anyOk());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');

    expect(f.init(0).signal).toBeInstanceOf(AbortSignal);
  });

  it("a rejected webhook is thrown with the status AND Discord's body, never swallowed", async () => {
    installFetch([{ match: () => true, reply: () => new Response('payload is too large', { status: 413 }) }]);
    const { VoiceMessageService } = await load();

    // A silent return here would leave the command saying "sent" for a message
    // Discord never accepted.
    await expect(
      new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token'),
    ).rejects.toThrow(/Webhook send failed 413: payload is too large/);
  });
});

describe('VoiceMessageService.sendViaChannel — the three-step attachment flow', () => {
  it('walks upload-url request, PUT, then message create — in that order', async () => {
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');

    expect([0, 1, 2].map((i) => `${f.init(i).method} ${f.url(i)}`)).toEqual([
      'POST https://discord.com/api/v10/channels/chan-1/attachments',
      'PUT https://cdn.discordapp.com/attachments/v2',
      'POST https://discord.com/api/v10/channels/chan-1/messages',
    ]);
  });

  it('asks for an upload slot with the real file size and the basename', async () => {
    stat.mockResolvedValue({ size: 123_456 });
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/nested/dir/voice clip.ogg', 'bot-token');

    // Discord rejects the PUT outright if file_size disagrees with the body, so
    // this must be the stat() of the file actually being sent — and the name
    // must match what the message later references.
    expect(f.json(0).files).toEqual([{ filename: 'voice clip.ogg', file_size: 123_456, id: '0' }]);
  });

  it('authenticates both JSON calls with the bot token', async () => {
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');

    expect((f.init(0).headers as Record<string, string>).Authorization).toBe('Bot bot-token');
    expect((f.init(2).headers as Record<string, string>).Authorization).toBe('Bot bot-token');
  });

  it('PUTs the audio bytes to the upload URL Discord handed back, as audio/ogg', async () => {
    readFile.mockResolvedValue(Buffer.from([9, 8, 7]));
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');

    expect(f.init(1).body).toEqual(Buffer.from([9, 8, 7]));
    expect((f.init(1).headers as Record<string, string>)['Content-Type']).toBe('audio/ogg');
  });

  it('the final message carries flags 8192, the duration and the waveform', async () => {
    getAudioDurationInSeconds.mockResolvedValue(18.25);
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');

    expect(f.json(2).flags).toBe(8192);
    const att = f.attachment(2);
    expect(att.duration_secs).toBe(18.25);
    expect(att.uploaded_filename).toBe('42_voice.ogg');
    // The message references the upload slot by the same id the slot used.
    expect(att.id).toBe('0');
    expect(typeof att.waveform).toBe('string');
  });

  it('a reply target becomes a message_reference, and its absence leaves the key out', async () => {
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();
    const svc = new VoiceMessageService();

    await svc.sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token', 'reply-to-1');
    expect(f.json(2).message_reference).toEqual({ message_id: 'reply-to-1' });

    f.clear();
    await svc.sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');
    expect(f.json(2)).not.toHaveProperty('message_reference');
  });

  it('returns the created message, so the caller can link it', async () => {
    installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await expect(new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token'))
      .resolves.toEqual({ id: 'm-1' });
  });

  it('a refused upload-slot request throws with the status and body, and never reaches the PUT', async () => {
    const f = installFetch([{ match: () => true, reply: () => new Response('Missing Access', { status: 403 }) }]);
    const { VoiceMessageService } = await load();

    await expect(new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token'))
      .rejects.toThrow(/attach req failed 403 Missing Access/);
    expect(f.count()).toBe(1);
  });

  it('an upload response with no attachment is an error, not a crash on data[0].upload_url', async () => {
    installFetch([
      { match: (u) => u.endsWith('/attachments'), reply: () => OK({ attachments: [] }) },
      { match: () => true, reply: () => OK() },
    ]);
    const { VoiceMessageService } = await load();

    await expect(new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token'))
      .rejects.toThrow(/No attachment in response/);
  });

  it('a refused upload PUT throws and never claims a message was sent', async () => {
    const f = installFetch([
      { match: (u) => u.endsWith('/attachments'), reply: () => OK(ATTACH_OK) },
      { match: (u) => u.startsWith('https://cdn.discordapp.com'), reply: () => new Response('', { status: 507 }) },
      { match: () => true, reply: () => OK() },
    ]);
    const { VoiceMessageService } = await load();

    await expect(new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token'))
      .rejects.toThrow(/PUT failed 507/);
    // Three calls would mean it went on to create a message Discord cannot
    // render, pointing at an upload that never landed.
    expect(f.count()).toBe(2);
  });

  it('a refused message create throws with the status and body', async () => {
    installFetch([
      { match: (u) => u.endsWith('/attachments'), reply: () => OK(ATTACH_OK) },
      { match: (u) => u.startsWith('https://cdn.discordapp.com'), reply: () => OK() },
      { match: () => true, reply: () => new Response('Cannot send an empty message', { status: 400 }) },
    ]);
    const { VoiceMessageService } = await load();

    await expect(new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token'))
      .rejects.toThrow(/send message failed 400 Cannot send an empty message/);
  });
});

describe('VoiceMessageService — where the ffprobe binary comes from', () => {
  // sendViaChannel walks the three-step attachment flow, so the double has to
  // answer the upload-slot leg with an `attachments` array — a blanket `{ok:true}`
  // dies on `data.attachments[0]` before ffprobe is ever asked.
  const oneProbe = async (oggPath: string): Promise<unknown[]> => {
    installFetch(happyRoutes());
    const { VoiceMessageService } = await load();
    await new VoiceMessageService().sendViaChannel('chan-1', oggPath, 'bot-token');
    return getAudioDurationInSeconds.mock.calls[0]!;
  };

  it('prefers the configured ffprobe path', async () => {
    const call = await oneProbe('/tmp/v.ogg');
    expect(call[0]).toBe('/tmp/v.ogg');
    expect(call[1]).toBe('/configured/ffprobe');
  });

  it('falls back to the Linux path only when nothing is configured AND it exists', async () => {
    // Reading it lazily (not at module scope) is deliberate: this file does not
    // import audioSignalService, so on a cold import order the value it
    // publishes may not exist yet.
    ffprobePath.mockReturnValue(undefined);
    existsSync.mockReturnValue(true);
    expect((await oneProbe('/tmp/v.ogg'))[1]).toBe('/usr/bin/ffprobe');
  });

  it('passes nothing rather than a path that does not exist, when both are absent', async () => {
    ffprobePath.mockReturnValue(undefined);
    existsSync.mockReturnValue(false);
    expect((await oneProbe('/tmp/v.ogg'))[1]).toBeUndefined();
  });

  it('does not consult the filesystem at all when a path is configured', async () => {
    await oneProbe('/tmp/v.ogg');
    expect(existsSync).not.toHaveBeenCalled();
  });
});

describe('VoiceMessageService — the waveform it sends', () => {
  /** One channel send, returning the decoded waveform bytes. */
  const sendOnce = async (oggPath: string): Promise<Buffer> => {
    // The real three-step flow: the upload-slot leg must answer with an
    // `attachments` array or production throws on `data.attachments[0]` and the
    // waveform is never generated.
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();
    await new VoiceMessageService().sendViaChannel('chan-1', oggPath, 'bot-token');
    return Buffer.from(f.lastJsonAttachment().waveform as string, 'base64');
  };

  /** One channel send with a pinned generator, returning the decoded bytes. */
  const waveformOf = async (oggPath: string, rand: number): Promise<Buffer> => {
    stubRandom(rand);
    return sendOnce(oggPath);
  };

  /** The same, but on the REAL generator — `Math.random` is left alone, which
   *  is the only way to show the bytes are drawn from the clock. */
  const liveWaveformOf = async (oggPath: string): Promise<Buffer> => sendOnce(oggPath);

  /** One webhook send with a pinned generator, returning the decoded bytes. */
  const hookWaveformOf = async (oggPath: string, rand: number): Promise<Buffer> => {
    stubRandom(rand);
    const f = installFetch([{ match: (u) => u.includes('/webhooks/'), reply: () => OK() }]);
    const { VoiceMessageService } = await load();
    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', oggPath, 'bot-token');
    return Buffer.from(f.hookAttachment(0).waveform as string, 'base64');
  };

  it('is exactly 100 bytes, the width Discord expects for a voice message', async () => {
    expect((await waveformOf('/tmp/v.ogg', 0.5)).length).toBe(100);
  });

  it('every sample sits in the audible 0-255 band Discord renders', async () => {
    const wave = await waveformOf('/tmp/v.ogg', 0.5);
    // floor(20 + rand*130) can never leave 20..149, so a 0 or a 255 here would
    // mean the range arithmetic changed.
    for (const v of wave) {
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(149);
    }
  });

  it('the low end of the generator is a flat 20 and the high end a flat 149', async () => {
    expect(await waveformOf('/tmp/v.ogg', 0)).toEqual(Buffer.alloc(100, 20));
    // 20 + 0.99999*130 = 149.9987 -> floor 149.
    expect(await waveformOf('/tmp/v.ogg', 0.99999)).toEqual(Buffer.alloc(100, 149));
  });

  it('the webhook path and the channel path generate the same waveform', async () => {
    stubRandom(0.25);
    const f = installFetch([
      { match: (u) => u.includes('/webhooks/'), reply: () => OK() },
      ...happyRoutes(),
    ]);
    const { VoiceMessageService } = await load();
    const svc = new VoiceMessageService();

    await svc.sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');
    const viaHook = f.hookAttachment(0).waveform as string;

    await svc.sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');
    const viaChannel = f.lastJsonAttachment().waveform as string;

    expect(viaHook).toBe(viaChannel);
  });

  /**
   * FINDING (pinned as current behaviour, NOT asserted to be correct).
   *
   * `generateWaveformAndDuration` and `sendViaChannel` do not decode the
   * audio. They fill a 100-byte buffer with `Math.floor(20 + Math.random()*130)`
   * and send it as `waveform` under the voice-message flag. So the waveform
   * Discord draws is uniform noise that changes on every send and says nothing
   * about the audio — a loud passage and a silent one draw identically. This is
   * exactly the "plausible falsehood" the bar forbids: a rendered value that
   * looks measured and was not. The real fix is an ffmpeg peak/`showwavespic`
   * pass, or leaving the field off entirely (Discord then draws a flat bar — a
   * truthful answer).
   *
   * Pinned so the day it becomes a real decode, this test fails loudly instead
   * of quietly accepting either behaviour.
   */
  it('is random noise, not a decode of the audio it is sent with', async () => {
    // Same file, same audio bytes, pinned generator -> identical waveform.
    // A decode cannot have that property.
    const withAudioA = await waveformOf('/tmp/v.ogg', 0.5);
    readFile.mockResolvedValue(Buffer.alloc(64));
    const withAudioB = await waveformOf('/tmp/v.ogg', 0.5);
    expect(withAudioA.equals(withAudioB)).toBe(true);

    // Same file, same audio, REAL generator -> different waveform. The bytes
    // depend on the clock, not on the sound. (This half must run on the real
    // Math.random; pinning it again would compare two identical buffers.)
    Math.random = realRandom;
    const first = await liveWaveformOf('/tmp/v.ogg');
    const second = await liveWaveformOf('/tmp/v.ogg');
    expect(first.equals(second)).toBe(false);
  });

  /**
   * FINDING (pinned as current behaviour, NOT asserted to be correct).
   *
   * `sendViaWebhook` computes `oggPath.endsWith('.m4a')` and hands it to
   * `generateWaveformAndDuration`, whose parameter is named `_isAac` and never
   * read. The `.m4a` branch is dead — Apple previews ARE m4a, so the flag the
   * caller bothers to compute changes nothing. Harmless today (the waveform is
   * random either way, see above) and it will matter the moment a real decode
   * lands, since AAC and Opus need different handling.
   */
  it('an m4a and an ogg of the same generator produce identical bytes — the isAac flag is ignored', async () => {
    // Exercised through the WEBHOOK path, because that is the only leg that
    // computes the flag at all (`oggPath.endsWith('.m4a')`,
    // voiceMessageService.ts:88). `sendViaChannel` never derives one, so a
    // comparison there would prove nothing about the dead `_isAac` parameter.
    const m4a = await hookWaveformOf('/tmp/preview.m4a', 0.4);
    const ogg = await hookWaveformOf('/tmp/preview.ogg', 0.4);
    expect(m4a.equals(ogg)).toBe(true);
    // And the flag really is computed and thrown away — the two payloads differ
    // only in their audio filename.
    expect(m4a.length).toBe(100);
  });
});
