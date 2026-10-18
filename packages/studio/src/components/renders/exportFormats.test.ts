import { describe, expect, it } from "vitest";
import { describeRange, fpsOptionsFor, markedRange, renderKind } from "./exportFormats";

describe("markedRange", () => {
  it("is the in/out range, or one point to the other end of the timeline", () => {
    expect(markedRange(1, 3, 6)).toEqual({ start: 1, end: 3 });
    expect(markedRange(2, null, 6)).toEqual({ start: 2, end: 6 });
    expect(markedRange(null, 4, 6)).toEqual({ start: 0, end: 4 });
  });

  it("is no range when nothing is marked or what is marked is empty", () => {
    expect(markedRange(null, null, 6)).toBeNull();
    expect(markedRange(6, null, 6)).toBeNull();
    expect(markedRange(2, null, 0)).toBeNull();
  });
});

describe("export format facts", () => {
  it("caps GIF at 30 fps", () => {
    expect(fpsOptionsFor("gif")).toEqual([24, 30]);
    expect(fpsOptionsFor("mp4")).toEqual([24, 30, 60]);
  });

  it.each([
    ["job.mp4", "video"],
    ["job.GIF", "gif"],
    ["job.zip", "frames"],
    ["job.m4a", "audio"],
  ])("shows %s as %s", (name, kind) => {
    expect(renderKind(name)).toBe(kind);
  });

  it("names a range in minutes, seconds and length", () => {
    expect(describeRange({ start: 61.5, end: 63 })).toBe("01:01.50 to 01:03.00 (1.50s)");
  });
});
