import { describe, expect, it } from "vitest";
import { isExportFormat, parseExportRange, planExport } from "./exportPlan";

describe("planExport", () => {
  it("hands a whole-timeline video, GIF or MOV straight to the producer", () => {
    for (const format of ["mp4", "webm", "mov", "gif"] as const) {
      expect(planExport(format, null)).toMatchObject({
        producerFormat: format,
        trimStart: 0,
        needsFinish: false,
      });
    }
    expect(planExport("gif", null).ext).toBe(".gif");
  });

  it("stops the producer at the out point and trims the head only when the range starts later", () => {
    expect(planExport("mp4", { start: 0, end: 2 })).toMatchObject({
      endSeconds: 2,
      trimStart: 0,
      needsFinish: false,
    });
    expect(planExport("mp4", { start: 1.5, end: 2 })).toMatchObject({
      endSeconds: 2,
      trimStart: 1.5,
      needsFinish: true,
    });
  });

  it("renders audio exports as MP4 and keeps their sound", () => {
    expect(planExport("wav", null)).toMatchObject({
      producerFormat: "mp4",
      ext: ".wav",
      needsFinish: true,
    });
  });

  it("zips a PNG sequence", () => {
    expect(planExport("png-sequence", null)).toMatchObject({
      producerFormat: "png-sequence",
      ext: ".zip",
      needsFinish: true,
    });
  });

  it("knows its formats", () => {
    expect(["mp4", "png-sequence", "m4a"].every(isExportFormat)).toBe(true);
    expect(isExportFormat("hls")).toBe(false);
  });
});

describe("parseExportRange", () => {
  it("reads seconds and treats no range as the whole timeline", () => {
    expect(parseExportRange({ start: 1, end: 2.5 })).toEqual({ start: 1, end: 2.5 });
    expect(parseExportRange(undefined)).toBeNull();
    expect(parseExportRange(null)).toBeNull();
  });

  it.each([
    ["a string", "1-2"],
    ["missing end", { start: 1 }],
    ["a negative start", { start: -1, end: 2 }],
    ["an end before its start", { start: 2, end: 1 }],
    ["an empty range", { start: 1, end: 1 }],
    ["infinity", { start: 0, end: Number.POSITIVE_INFINITY }],
  ])("refuses %s", (_case, value) => {
    expect(parseExportRange(value)).toMatchObject({ error: expect.any(String) });
  });
});
