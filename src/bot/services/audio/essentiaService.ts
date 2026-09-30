import { Logger } from '@domain/logger';

interface EssentiaInstance {
  arrayToVector(arr: Float32Array): unknown;
  RhythmExtractor2013(vector: unknown): { bpm?: number } | null;
  KeyExtractor(vector: unknown): { key?: string } | null;
  deleteVector?(vector: unknown): void;
}

/**
 * The sample rate Essentia's `RhythmExtractor2013` and `KeyExtractor` are
 * defined for.
 *
 * These algorithms work in SECONDS, so a signal at 48kHz handed to a 44.1kHz
 * beat tracker reports a tempo ~8.8% off (and a key derived from a chromagram
 * built on the wrong window length). Nothing in this module used to notice:
 * `analyze` took only the samples, so the rate was structurally invisible and a
 * CDN serving 48kHz previews would quietly have produced wrong numbers with no
 * error anywhere.
 *
 * Declared here rather than imported because this module must stay a leaf —
 * `audioSignalService` pulls in ffmpeg-static, fluent-ffmpeg and child_process,
 * and essentiaService is required by tests that want nothing but a WASM
 * analyser. The two constants are coupled at runtime by the check in `analyze`
 * (a mismatch returns null + WARN, it cannot pass silently) and asserted equal
 * by `audioBinaryResolution.test.ts`.
 */
export const ESSENTIA_SAMPLE_RATE = 44100;

let essentiaInstance: EssentiaInstance | null = null;
let initFailed = false;

function getEssentia(): EssentiaInstance | null {
  if (essentiaInstance !== null) return essentiaInstance;
  if (initFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esPkg = require('essentia.js') as { Essentia?: new (wasm: unknown) => EssentiaInstance; EssentiaWASM?: unknown };
    const Essentia = esPkg.Essentia;
    const WASM = esPkg.EssentiaWASM;
    if (!Essentia || !WASM) throw new Error('Essentia export missing');
    essentiaInstance = new Essentia(WASM);
    return essentiaInstance;
  } catch (err) {
    Logger.warn({ err }, '[Essentia] init failed — BPM/key will be unavailable');
    initFailed = true;
    essentiaInstance = null;
    return null;
  }
}

function formatKey(key: string): string {
  const sharpMap: Record<string, string> = {
    A: 'A', Bb: 'A#', B: 'B', C: 'C', Db: 'C#', D: 'D',
    Eb: 'D#', E: 'E', F: 'F', Gb: 'F#', G: 'G', Ab: 'G#',
  };
  if (!key || key === 'N/A') return 'N/A';
  return sharpMap[key] ?? key;
}

export class EssentiaService {
  public isAvailable(): boolean {
    return getEssentia() !== null;
  }

  public analyze(signal: Float32Array, sampleRate: number = ESSENTIA_SAMPLE_RATE): { bpm: number; key: string } | null {
    const es = getEssentia();
    if (!es || !signal || signal.length < 4410) return null;
    // A signal at the wrong rate is not "degraded analysis", it is a different
    // (wrong) answer, and the caller cannot tell it apart from a real one.
    // Refusing is the only honest option, and it is above DEBUG because the
    // whole BPM/key feature is silently gone while the track card still renders.
    if (sampleRate !== ESSENTIA_SAMPLE_RATE) {
      Logger.warn({ sampleRate, expected: ESSENTIA_SAMPLE_RATE }, '[Essentia] refusing a signal at the wrong sample rate — BPM/key unavailable');
      return null;
    }
    try {
      const vector = es.arrayToVector(signal);
      const rhythm = es.RhythmExtractor2013(vector);
      const bpm = rhythm && rhythm.bpm ? Math.round(rhythm.bpm * 10) / 10 : 0;
      const keyData = es.KeyExtractor(vector);
      const keyStr = keyData && keyData.key ? formatKey(keyData.key) : 'N/A';
      // Free vectors if API exposes delete
      // CORRECT AS IS: releasing WASM scratch memory only. The analysis
      // result is already computed into locals above, so a vector-free that
      // throws cannot change the bpm/key returned — and the enclosing catch
      // would turn a leak into a lost analysis, which is strictly worse.
      try { es.deleteVector?.(vector); } catch { /* ignore */ }
      if (!bpm) return null;
      return { bpm, key: keyStr };
    } catch (err) {
      Logger.warn({ err }, '[Essentia] analysis failed');
      return null;
    }
  }
}
