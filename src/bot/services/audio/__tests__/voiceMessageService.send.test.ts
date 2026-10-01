import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `VoiceMessageService` — the two Discord upload paths for a preview voice
 * message (multipart webhook followup, and the three-step channel attachment
 * flow) plus the duration derivation they send alongside the audio.
 *
 * No real ffmpeg, no real Discord, no real audio. The probe layer is behind
 * `get-audio-duration`, the file reads are behind `fs/promises` and the
 * waveform decode is behind `buildVoiceWaveform`, so all three are faked and
 * every assertion is about WHAT THE SERVICE HANDS TO DISCORD — the payload,
 * the flags, the duration it claims, and the waveform it derived.
 *
 * The claim that matters most is the last one: the waveform in the payload is
 * the one the decoder returned for the file being sent, and no send path
 * invents one. See the `the waveform it measures` describe.
 */

const { getAudioDurationInSeconds } = vi.hoisted(() => ({
  getAudioDurationInSeconds: vi.fn(async (..._args: unknown[]): Promise<number> => 12.5),
}));

const { readFile, stat, existsSync, ffprobePath, buildVoiceWaveform, logger } = vi.hoisted(() => ({
  readFile: vi.fn(async (..._args: unknown[]): Promise<Buffer> => Buffer.from('ogg-bytes')),
  stat: vi.fn(async (..._args: unknown[]): Promise<{ size: number }> => ({ size: 4096 })),
  existsSync: vi.fn((..._args: unknown[]): boolean => false),
  ffprobePath: vi.fn((..._args: unknown[]): string | undefined => '/configured/ffprobe'),
  buildVoiceWaveform: vi.fn(async (..._args: unknown[]): Promise<string> => 'bWVhc3VyZWQ='),
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
// Only the decoder is doubled. The waveform ENCODER is pure and is tested
// against real signals in voiceWaveform.test.ts, so there is no reason to
// pretend the bytes here came from a decoder that never ran.
vi.mock('../audioSignalService', () => ({ buildVoiceWaveform }));

/** Fresh module per test, so the fs/runtimeEnv mocks attach to the instance
 *  under test rather than to a module graph cached by an earlier file. */
const load = async (): Promise<typeof import('../voiceMessageService')> => {
  vi.resetModules();
  return import('../voiceMessageService');
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
 *  leave a shared static stubbed for a later test. A fabrication attempt calls
 *  `Math.random`, so a THROW is the strongest possible assertion that no send
 *  path draws one: the send either completes or the test fails. */
const realRandom = Math.random;
const forbidRandom = (): void => {
  Math.random = () => {
    throw new Error('a voice payload drew a waveform it never decoded');
  };
};

/** A waveform a real decode would produce, distinct per call so a test can tell
 *  two decodes apart. 200 datapoints is a 20s preview. */
const decode = (tag: string): string => Buffer.alloc(200, tag.charCodeAt(0)).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  getAudioDurationInSeconds.mockResolvedValue(12.5);
  readFile.mockResolvedValue(Buffer.from('ogg-bytes'));
  stat.mockResolvedValue({ size: 4096 });
  existsSync.mockReturnValue(false);
  ffprobePath.mockReturnValue('/configured/ffprobe');
  buildVoiceWaveform.mockImplementation(async () => decode('a'));
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

  it('the final message carries flags 8192, the measured duration, and the measured waveform', async () => {
    getAudioDurationInSeconds.mockResolvedValue(18.25);
    buildVoiceWaveform.mockImplementation(async () => decode('w'));
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');

    expect(f.json(2).flags).toBe(8192);
    const att = f.attachment(2);
    expect(att.duration_secs).toBe(18.25);
    expect(att.uploaded_filename).toBe('42_voice.ogg');
    // The message references the upload slot by the same id the slot used.
    expect(att.id).toBe('0');
    // Discord refuses the whole message with 400/50161 ("Voice messages must
    // have supporting metadata") when this field is absent. Verified against
    // the live API, not inferred: the same payload without it was refused,
    // and with it returned 200.
    expect(att.waveform).toBe(decode('w'));
    expect(Buffer.from(String(att.waveform), 'base64')).toHaveLength(200);
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

describe('VoiceMessageService — the waveform it measures', () => {
  /**
   * Discord REQUIRES this field. `flags: 8192` + a real Opus OGG +
   * `duration_secs`, and no `waveform`, comes back `400 Voice messages must
   * have supporting metadata` (code 50161) from the live API. The payload that
   * omitted it did not render a flat bar; it did not send.
   *
   * It used to send 100 bytes of `Math.floor(20 + Math.random() * 130)`, which
   * was deleted because a loud passage and a silent one drew identically and
   * the drawing changed on every send. The field was then left out entirely on
   * the grounds that omitting it was honest — and that shipped a preview
   * button that 400s on every press. Honest and broken are not the same thing.
   *
   * So the waveform is now MEASURED: `buildVoiceWaveform` decodes the same
   * file being uploaded and returns its real envelope. The assertions below
   * lock in that it is the decoder's output for THIS file (not a constant),
   * that it is deterministic, and that no send path can draw one — from
   * either end, by asserting the payload and by making `Math.random` throw.
   */

  /** One channel send, returning the attachment actually posted. */
  const sendViaChannelOnce = async (oggPath: string): Promise<Record<string, unknown>> => {
    // The real three-step flow: the upload-slot leg must answer with an
    // `attachments` array or production throws on `data.attachments[0]`.
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();
    await new VoiceMessageService().sendViaChannel('chan-1', oggPath, 'bot-token');
    return f.lastJsonAttachment();
  };

  /** One webhook send, returning the attachment actually posted. */
  const sendViaWebhookOnce = async (oggPath: string): Promise<Record<string, unknown>> => {
    const f = installFetch([{ match: (u) => u.includes('/webhooks/'), reply: () => OK() }]);
    const { VoiceMessageService } = await load();
    await new VoiceMessageService().sendViaWebhook('app-1', 'tok-1', oggPath, 'bot-token');
    return f.hookAttachment(0);
  };

  it('the channel path sends the waveform the decoder produced for that file', async () => {
    buildVoiceWaveform.mockImplementation(async () => decode('c'));
    const att = await sendViaChannelOnce('/tmp/v.ogg');
    expect(att.waveform).toBe(decode('c'));
    // The honest fields survive alongside it, so this is an addition and not a
    // replacement of everything measured with something drawn.
    expect(att.duration_secs).toBe(12.5);
    expect(att.uploaded_filename).toBe('42_voice.ogg');
  });

  it('the webhook path sends one too, because Discord refuses it there as well', async () => {
    buildVoiceWaveform.mockImplementation(async () => decode('h'));
    const att = await sendViaWebhookOnce('/tmp/v.ogg');
    expect(att.waveform).toBe(decode('h'));
    expect(att.duration_secs).toBe(12.5);
    expect(att.filename).toBe('voice-message.ogg');
  });

  it('the decoder is asked about the exact file being uploaded', async () => {
    await sendViaChannelOnce('/tmp/nested/dir/voice clip.ogg');
    expect(buildVoiceWaveform).toHaveBeenCalledTimes(1);
    expect(buildVoiceWaveform).toHaveBeenCalledWith('/tmp/nested/dir/voice clip.ogg');
  });

  it('a file that cannot be decoded fails the send instead of posting a drawn waveform', async () => {
    // The honest shape of this failure. There is no valid voice message
    // without the field, so a decode failure must surface as a refused
    // preview rather than be papered over.
    buildVoiceWaveform.mockRejectedValue(new Error('ffmpeg exited with code 1'));
    const f = installFetch(happyRoutes());
    const { VoiceMessageService } = await load();

    await expect(new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token'))
      .rejects.toThrow(/ffmpeg exited with code 1/);
    // The message-create leg must not be reached: nothing was posted.
    expect(f.count()).toBe(0);
  });

  it('the channel path decodes BEFORE asking Discord for an upload slot', async () => {
    // Ordering is the cheap version of the test above: two wasted round trips
    // and a PUT of bytes no message will reference is worse than failing fast.
    const order: string[] = [];
    buildVoiceWaveform.mockImplementation(async () => {
      order.push('decode');
      return decode('o');
    });
    const f = installFetch([
      { match: (u, i) => u.endsWith('/attachments') && i.method === 'POST', reply: () => {
        order.push('slot');
        return OK(ATTACH_OK);
      } },
      { match: (u) => u === 'https://cdn.discordapp.com/attachments/v2', reply: () => {
        order.push('put');
        return OK();
      } },
      { match: () => true, reply: () => {
        order.push('message');
        return OK({ id: 'm-1' });
      } },
    ]);
    const { VoiceMessageService } = await load();
    await new VoiceMessageService().sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');
    expect(order).toEqual(['decode', 'slot', 'put', 'message']);
    expect(f.attachment(f.count() - 1).waveform).toBe(decode('o'));
  });

  it('neither send path can draw a waveform, because neither may call Math.random', async () => {
    // The direct form of the same claim: a fabrication attempt calls
    // `Math.random`, so with it throwing, a reintroduced generator fails the
    // send loudly instead of quietly producing plausible noise again. Both
    // payloads still have to come out the far side, carrying what the decoder
    // returned.
    forbidRandom();

    const f = installFetch([
      { match: (u) => u.includes('/webhooks/'), reply: () => OK() },
      ...happyRoutes(),
    ]);
    const { VoiceMessageService } = await load();
    const svc = new VoiceMessageService();

    await svc.sendViaWebhook('app-1', 'tok-1', '/tmp/v.ogg', 'bot-token');
    expect(f.hookAttachment(0).waveform).toBe(decode('a'));

    await svc.sendViaChannel('chan-1', '/tmp/v.ogg', 'bot-token');
    expect(f.lastJsonAttachment().waveform).toBe(decode('a'));
  });

  it('the file extension cannot change the payload: there is no isAac branch left', async () => {
    // `sendViaWebhook` used to compute `oggPath.endsWith('.m4a')` and hand it to
    // a helper whose parameter was named `_isAac` and never read. The branch is
    // gone, so an AAC preview and an Opus one describe themselves identically and
    // nothing about the extension reaches Discord. Comparing the key SETS (not
    // values) is what makes this fail if a per-format field is ever added back.
    buildVoiceWaveform.mockImplementation(async () => decode('same'));
    const m4a = await sendViaWebhookOnce('/tmp/preview.m4a');
    const ogg = await sendViaWebhookOnce('/tmp/preview.ogg');
    expect(Object.keys(m4a).sort()).toEqual(Object.keys(ogg).sort());
    expect(m4a).toEqual(ogg);
  });

  it('two sends of the same audio produce the same payload, because none of it is drawn', async () => {
    // The property the fabrication destroyed. Same file, same bytes, same
    // answer — which is what "measured" looks like. Note the decoder is
    // stubbed to return the same thing both times because a real decode of the
    // same file is deterministic; voiceWaveform.test.ts proves that directly.
    buildVoiceWaveform.mockImplementation(async () => decode('d'));
    const first = await sendViaChannelOnce('/tmp/v.ogg');
    const second = await sendViaChannelOnce('/tmp/v.ogg');
    expect(first).toEqual(second);
    expect(first.waveform).toBe(decode('d'));
  });
});
