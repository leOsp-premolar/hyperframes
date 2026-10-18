import { describe, expect, it } from "vitest";
import { landedSeekTime, settleOnFrame } from "./timelineSeekLanding";

const at = (time: number) => ({ getTime: () => time });

describe("landedSeekTime", () => {
  it("keeps the frame the runtime landed on", () => {
    expect(landedSeekTime(at(1.5), 1.514)).toBe(1.5);
    expect(landedSeekTime(at(2), 2)).toBe(2);
  });

  it("keeps the requested time when the adapter has not moved there", () => {
    expect(landedSeekTime(at(0), 1.514)).toBe(1.514);
    expect(landedSeekTime(at(1.6), 1.514)).toBe(1.514);
    expect(landedSeekTime(at(Number.NaN), 1.514)).toBe(1.514);
  });
});

describe("settleOnFrame", () => {
  it("seeks to where playback stopped and keeps the frame it lands on", () => {
    let time = 1.5682;
    const adapter = {
      getTime: () => time,
      seek: (to: number) => {
        time = Math.floor(to * 30 + 1e-9) / 30;
      },
    };
    expect(settleOnFrame(adapter)).toBeCloseTo(47 / 30, 9);
  });
});
