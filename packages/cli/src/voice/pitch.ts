import { execFile } from "node:child_process";

const RATE = 16_000;
const FRAME = 640; // 40 ms: two periods of the lowest pitch tracked
const HOP = 160; // 10 ms
const MIN_HZ = 60;
const MAX_HZ = 500;
// YIN's absolute threshold on the cumulative mean normalized difference.
const THRESHOLD = 0.15;

const MAX_LAG = Math.floor(RATE / MIN_HZ);
const MIN_LAG = Math.floor(RATE / MAX_HZ);
const WIDTH = FRAME - MAX_LAG;

/** YIN's cumulative mean normalized difference of one frame, for lags 0..MAX_LAG. */
function normalizedDifference(x: Float32Array, start: number): Float32Array {
  const d = new Float32Array(MAX_LAG + 1);
  let running = 0;
  d[0] = 1;
  for (let lag = 1; lag <= MAX_LAG; lag++) {
    let sum = 0;
    for (let i = start; i < start + WIDTH; i++) {
      const delta = x[i]! - x[i + lag]!;
      sum += delta * delta;
    }
    running += sum;
    d[lag] = running > 0 ? (sum * lag) / running : 1;
  }
  return d;
}

/** The first lag whose difference dips under the threshold, followed to the bottom of the dip. */
function firstDip(d: Float32Array): number {
  let lag = MIN_LAG;
  while (lag < MAX_LAG && d[lag]! >= THRESHOLD) lag++;
  if (lag >= MAX_LAG) return 0;
  while (lag + 1 < MAX_LAG && d[lag + 1]! < d[lag]!) lag++;
  return lag;
}

/** A parabola through the dip and its neighbours places the period between samples. */
function refine(d: Float32Array, lag: number): number {
  const a = d[lag - 1]!;
  const b = d[lag]!;
  const c = d[lag + 1]!;
  const curve = a + c - 2 * b;
  return curve === 0 ? lag : lag + (a - c) / (2 * curve);
}

/**
 * The fundamental frequency of one frame by YIN (de Cheveigné and Kawahara, 2002), or 0 when
 * the frame is not voiced.
 */
function framePitch(x: Float32Array, start: number): number {
  const d = normalizedDifference(x, start);
  const lag = firstDip(d);
  return lag ? RATE / refine(d, lag) : 0;
}

/** The median pitch of the voiced frames in 16 kHz mono samples, or null when none is voiced. */
export function medianPitch(samples: Float32Array): number | null {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  // Frames far below the loudest are breath and room, not voice.
  const floor = peak * 0.05;
  const pitches: number[] = [];
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    let energy = 0;
    for (let i = start; i < start + FRAME; i++)
      energy = Math.max(energy, Math.abs(samples[i] ?? 0));
    if (energy < floor) continue;
    const hz = framePitch(samples, start);
    if (hz > 0) pitches.push(hz);
  }
  if (pitches.length < 10) return null;
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] ?? null;
}

/** Decodes `file` to 16 kHz mono and measures its median pitch; null when it has no voice. */
export function measurePitch(
  ffmpeg: string,
  file: string,
  signal: AbortSignal,
): Promise<number | null> {
  const args = ["-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"];
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      args,
      { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, signal },
      (err, stdout) => {
        if (err) return reject(err);
        const bytes = stdout.byteLength - (stdout.byteLength % 4);
        const copy = new Uint8Array(stdout.subarray(0, bytes)).buffer;
        resolve(medianPitch(new Float32Array(copy)));
      },
    );
  });
}
