import { describe, it, expect } from 'vitest';
import { encodeVoiceWaveform, waveformPointCount, MAX_WAVEFORM_POINTS } from '@bot/services/audio/voiceWaveform';

const SR = 44100;
const bytes = (b64: string): number[] => [...Buffer.from(b64, 'base64')];

/** A signal of `seconds` where the first `activeSeconds` carry `amp`. */
const signal = (seconds: number, activeSeconds: number, amp: number, sign = 1): Float32Array => {
  const sig = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < Math.floor(activeSeconds * SR) && i < sig.length; i += 1) {
    sig[i] = sign * amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  }
  return sig;
};

describe('waveformPointCount — the datapoint budget', () => {
  // The rule is the client's: sample at most once per 100ms, then downsample
  // to at most 256. A preview is 20-30s, so 20s is a 200-point waveform and
  // anything at or past 25.6s saturates the 256 ceiling.
  it('is one datapoint per 100ms, so a 20s preview draws 200 points', () => {
    expect(waveformPointCount(20)).toBe(200);
    expect(waveformPointCount(1)).toBe(10);
  });

  it('caps at the 256 datapoints Discord will render', () => {
    expect(waveformPointCount(60)).toBe(MAX_WAVEFORM_POINTS);
    expect(waveformPointCount(30)).toBe(MAX_WAVEFORM_POINTS);
    // 25.6s * 10 = 256 exactly: the boundary must not go over.
    expect(waveformPointCount(25.6)).toBe(256);
    expect(waveformPointCount(25.7)).toBe(256);
    expect(waveformPointCount(100)).toBe(256);
  });

  it('rounds a partial final interval UP, so the tail of the audio is not dropped', () => {
    // 20.01s needs a 201st point to cover the last 10ms. Truncating here would
    // silently clip the end of every preview.
    expect(waveformPointCount(20.01)).toBe(201);
  });

  it('an empty or unusable duration still yields a renderable single point', () => {
    // Not 0: a zero-length waveform is what a client cannot draw, and the
    // service would then be sending a field that renders as nothing.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(waveformPointCount(bad)).toBe(1);
    }
  });
});

describe('encodeVoiceWaveform — silence', () => {
  it('pure silence encodes to the 128 silence point at every datapoint', () => {
    const out = bytes(encodeVoiceWaveform(new Float32Array(SR), SR));
    expect(out).toHaveLength(10);
    expect(new Set(out)).toEqual(new Set([128]));
  });

  it('a silent signal is not the same array as silence-shaped noise', () => {
    // The regression that matters: the deleted implementation drew from
    // Math.random(), so a silent file and a loud one came out looking alike.
    const loud = bytes(encodeVoiceWaveform(signal(1, 1, 0.9), SR));
    const quiet = bytes(encodeVoiceWaveform(new Float32Array(SR), SR));
    expect(loud).not.toEqual(quiet);
    expect(loud.some((b) => Math.abs(b - 128) > 40)).toBe(true);
  });
});

describe('encodeVoiceWaveform — it reports the audio, not a constant', () => {
  it('locates activity in time: a burst in the first second does not light the second', () => {
    const out = bytes(encodeVoiceWaveform(signal(2, 1, 0.9), SR));
    expect(out).toHaveLength(20);
    // First 10 points are the active half, last 10 are silence.
    expect(out.slice(0, 10).some((b) => b !== 128)).toBe(true);
    expect(out.slice(10)).toEqual(new Array(10).fill(128));
  });

  it('reports loudness, so a quiet passage draws below a loud one', () => {
    const quiet = bytes(encodeVoiceWaveform(signal(1, 1, 0.05), SR));
    const loud = bytes(encodeVoiceWaveform(signal(1, 1, 0.9), SR));
    const spread = (a: number[]): number => Math.max(...a.map((b) => Math.abs(b - 128)));
    expect(spread(quiet)).toBeLessThan(spread(loud));
    // 0.05 of full scale is ~6 datapoints of swing, not zero: a quiet passage
    // is still drawn, just smaller.
    expect(spread(quiet)).toBeGreaterThan(0);
  });

  it('keeps the SIGN, so a negative excursion draws below the silence point', () => {
    // Discord stores a signed byte centred on 128. A magnitude-only encoder
    // would draw a half-cycle bass note as a full-volume hit.
    //
    // A one-signed signal, NOT an inverted sine: a 440Hz sine swings both ways
    // within a single bucket, so the signed extreme of a bucket is whichever
    // polarity happened to peak there and says nothing about polarity. That is
    // the encoder working — it reports the loudest instant — so the test has to
    // ask about a signal that only ever goes one way.
    const dc = (v: number): Float32Array => new Float32Array(SR).fill(v);
    const negative = bytes(encodeVoiceWaveform(dc(-0.8), SR));
    const positive = bytes(encodeVoiceWaveform(dc(0.8), SR));
    expect(Math.min(...negative)).toBeLessThan(128);
    expect(Math.max(...positive)).toBeGreaterThan(128);
    // Symmetric: the same magnitude draws the same distance either side.
    expect(128 - Math.min(...negative)).toBe(Math.max(...positive) - 128);
  });

  it('full scale saturates at 1 and 255 without wrapping past the silence point', () => {
    const full = new Float32Array(SR).fill(-1);
    const out = bytes(encodeVoiceWaveform(full, SR));
    expect(out[0]).toBe(1);
    // A wrap would put a loud sample on the quiet side of 128.
    expect(out.every((b) => b <= 255 && b >= 0)).toBe(true);
  });
});

describe('encodeVoiceWaveform — determinism and shape', () => {
  it('the same signal encodes to the same waveform every time', () => {
    // The property the Math.random() implementation destroyed. Same bytes in,
    // same bytes out, so a re-send draws the same shape.
    const sig = signal(3, 2, 0.6);
    const a = encodeVoiceWaveform(sig, SR);
    const b = encodeVoiceWaveform(sig, SR);
    expect(a).toBe(b);
    expect(a).toBe(encodeVoiceWaveform(signal(3, 2, 0.6), SR));
  });

  it('returns base64, which is what the API field is typed as', () => {
    const out = encodeVoiceWaveform(signal(1, 1, 0.5), SR);
    expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // 10 datapoints round-trips to exactly 10 bytes.
    expect(Buffer.from(out, 'base64')).toHaveLength(10);
  });

  it('handles a signal length that does not divide evenly into datapoints', () => {
    // Equal-width buckets over a prime-ish length: the arithmetic must not
    // assume whole division, or the tail points come out empty/aliased.
    const sig = new Float32Array(44_137);
    for (let i = 0; i < sig.length; i += 1) sig[i] = Math.sin(i / 20) * 0.7;
    const out = bytes(encodeVoiceWaveform(sig, SR));
    expect(out).toHaveLength(waveformPointCount(44_137 / SR));
    // Every point must have seen a sample, so none can be untouched silence.
    expect(out.filter((b) => b === 128).length).toBe(0);
  });

  it('an empty signal is an empty string, not a throw and not a lie', () => {
    expect(encodeVoiceWaveform(new Float32Array(0), SR)).toBe('');
  });
});
