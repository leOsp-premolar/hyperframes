import { describe, expect, it } from "vitest";
import { medianPitch } from "./pitch.js";

const RATE = 16_000;

/** A voiced tone: the fundamental and falling harmonics, like a sung vowel. */
function voiced(hz: number, seconds = 1): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    let sample = 0;
    for (let h = 1; h <= 6; h++) sample += Math.sin(2 * Math.PI * hz * h * t) / h;
    out[i] = sample;
  }
  return out;
}

describe("medianPitch", () => {
  it.each([92, 120, 185, 245])("reads a %s Hz voice within a quarter tone", (hz) => {
    const measured = medianPitch(voiced(hz));
    expect(measured).not.toBeNull();
    expect(Math.abs(12 * Math.log2((measured ?? 0) / hz))).toBeLessThan(0.5);
  });

  it("ignores the quiet frames around the voice", () => {
    const line = new Float32Array(RATE * 2);
    line.set(voiced(150, 1), RATE / 2);
    // A faint, fixed hiss before the voice.
    for (let i = 0; i < RATE / 2; i++) line[i] = (((i * 7919) % 101) / 101 - 0.5) * 0.01;
    expect(Math.abs(12 * Math.log2((medianPitch(line) ?? 0) / 150))).toBeLessThan(0.5);
  });

  it("finds no pitch in silence", () => {
    expect(medianPitch(new Float32Array(RATE))).toBeNull();
  });
});
