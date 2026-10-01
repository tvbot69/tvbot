/**
 * Voice-message waveform encoding.
 *
 * WHY THIS EXISTS
 * ---------------
 * Discord rejects a message sent with `IS_VOICE_MESSAGE` and no `waveform`
 * with `400 Voice messages must have supporting metadata` (error code
 * 50161). That was verified against the live API, not read off a doc page:
 * a payload carrying `flags: 8192` + a real Opus OGG + `duration_secs`, and
 * no `waveform`, came back 400/50161. Adding the field made the identical
 * payload return 200. So omitting it is not "a flat bar" — it is a refused
 * message. The previous version of this service left the field out on
 * purpose (a fabricated `Math.random()` array had been removed) and its
 * comment claimed Discord would draw a flat bar. That comment was wrong, and
 * the feature did not work.
 *
 * THE REPLACEMENT IS A MEASUREMENT, NOT A FABRICATION
 * ---------------------------------------------------
 * The old code drew amplitudes from `Math.random()`. This decodes the audio
 * and reports the real envelope of the decoded samples. Same input file,
 * same bytes, same waveform, every time — which is what "measured" means and
 * is the property the fabrication destroyed.
 *
 * THE BYTE CONVENTION
 * -------------------
 * Discord's clients store each datapoint as a SIGNED 8-bit value centred on
 * 128: 128 is silence, 255 full positive, 0 full negative. That is the
 * convention discord.py decodes with (`<B` unpacked through `<b`), and it is
 * why a waveform cannot simply be a magnitude in 0..255 — a magnitude would
 * draw every sound as if it swung in one direction.
 *
 * Datapoint count follows the documented rule: the client samples at most
 * once per 100ms, then downsamples to at most 256 points. So a 20s preview
 * carries 200 points and a 60s one carries 256.
 */

/** 256 is the documented ceiling on datapoints Discord will render. */
export const MAX_WAVEFORM_POINTS = 256;

/** The client samples the recording at most once per 100ms. */
const DATAPOINTS_PER_SECOND = 10;

/** Signed 8-bit with 128 as the zero point, so the render is symmetric. */
const SILENCE = 128;

/**
 * How many datapoints a signal of this many seconds gets: one per 100ms,
 * capped at 256.
 *
 * Exported because it is the rule a test should be able to state directly —
 * "a 20s preview is 200 points" is a fact about the encoding, not about the
 * audio, and it is the boundary a wrong implementation gets wrong.
 */
export function waveformPointCount(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.min(MAX_WAVEFORM_POINTS, Math.max(1, Math.ceil(seconds * DATAPOINTS_PER_SECOND)));
}

/**
 * The base64 waveform for a block of decoded PCM.
 *
 * One datapoint per bucket, and inside a bucket the sample of greatest
 * ABSOLUTE value wins — its SIGN included. Taking the magnitude would draw a
 * half-cycle bass note as a full-volume hit; taking the signed extreme keeps
 * the shape of the waveform rather than its loudness alone.
 *
 * Buckets are equal-width over the signal, so a bucket is
 * `length / points` frames wide, which means the last bucket can be shorter
 * and the arithmetic has to tolerate that rather than assume whole division.
 *
 * @param samples Decoded audio. Any rate; only the length in seconds is used
 *   to decide how many datapoints to draw.
 */
export function encodeVoiceWaveform(samples: Float32Array, sampleRate: number): string {
  if (samples.length === 0) return '';
  const points = waveformPointCount(samples.length / sampleRate);
  const bytes = new Uint8Array(points);

  for (let p = 0; p < points; p += 1) {
    const start = Math.floor((p * samples.length) / points);
    const end = Math.max(start + 1, Math.floor(((p + 1) * samples.length) / points));
    let extreme = 0;
    for (let i = start; i < end && i < samples.length; i += 1) {
      const v = samples[i] as number;
      if (Math.abs(v) > Math.abs(extreme)) extreme = v;
    }
    // 127 rather than 128 so a full-scale sample lands on 255/1 and never
    // wraps around to the far side of the silence point.
    const scaled = SILENCE + Math.round(Math.max(-1, Math.min(1, extreme)) * 127);
    bytes[p] = Math.max(0, Math.min(255, scaled));
  }

  return Buffer.from(bytes).toString('base64');
}