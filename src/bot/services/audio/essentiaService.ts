import { Logger } from '@domain/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let essentiaInstance: any = null;
let initFailed = false;

function getEssentia(): any | null {
  if (essentiaInstance !== null) return essentiaInstance;
  if (initFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esPkg: any = require('essentia.js');
    const Essentia = esPkg.Essentia ?? esPkg.default?.Essentia ?? esPkg;
    const WASM = esPkg.EssentiaWASM ?? esPkg.default?.EssentiaWASM;
    if (!Essentia || !WASM) throw new Error('Essentia export missing');
    essentiaInstance = new Essentia(WASM);
    return essentiaInstance;
  } catch (err) {
    Logger.warn({ err }, '[Essentia] init failed — BPM/key will be unavailable');
    initFailed = true;
    essentiaInstance = false as any;
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

  public analyze(signal: Float32Array): { bpm: number; key: string } | null {
    const es = getEssentia();
    if (!es || !signal || signal.length < 4410) return null;
    try {
      const vector = es.arrayToVector(signal);
      const rhythm = es.RhythmExtractor2013(vector);
      const bpm = rhythm && rhythm.bpm ? Math.round(rhythm.bpm * 10) / 10 : 0;
      const keyData = es.KeyExtractor(vector);
      const keyStr = keyData && keyData.key ? formatKey(keyData.key) : 'N/A';
      // Free vectors if API exposes delete
      try { es.deleteVector?.(vector); } catch { /* ignore */ }
      if (!bpm) return null;
      return { bpm, key: keyStr };
    } catch (err) {
      Logger.warn({ err }, '[Essentia] analysis failed');
      return null;
    }
  }
}
