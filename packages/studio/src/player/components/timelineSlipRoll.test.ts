import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import {
  canSlip,
  findRollPartner,
  previewSlipRoll,
  resolveRoll,
  resolveSlip,
  rollDeltaBounds,
  slipMembers,
} from "./timelineSlipRoll";

function clip(id: string, start: number, duration: number, extra: Partial<TimelineElement> = {}) {
  const element: TimelineElement = {
    id,
    key: id,
    tag: "video",
    kind: "video",
    start,
    duration,
    track: 0,
    playbackStart: 2,
    sourceDuration: 10,
    ...extra,
  };
  return element;
}

const changeOf = (session: ReturnType<typeof resolveSlip>, id: string) =>
  session.changes.find((change) => change.key === id);

describe("slip", () => {
  it("slides the source under a fixed window: right shows earlier source", () => {
    const a = clip("a", 1, 3);
    const right = resolveSlip(a, [a], 0.5);
    expect(changeOf(right, "a")).toMatchObject({ start: 1, duration: 3, playbackStart: 1.5 });
    expect(right.hasChanged).toBe(true);
    expect(changeOf(resolveSlip(a, [a], -1), "a")?.playbackStart).toBe(3);
  });

  it("stops at either end of the source", () => {
    const a = clip("a", 1, 3);
    expect(changeOf(resolveSlip(a, [a], 9), "a")?.playbackStart).toBe(0);
    // 10s of source, 3s shown: the in-point goes no further than 7s.
    expect(changeOf(resolveSlip(a, [a], -9), "a")?.playbackStart).toBe(7);
  });

  it("scales by playback rate", () => {
    const fast = clip("a", 0, 2, { playbackRate: 2, playbackStart: 3 });
    expect(changeOf(resolveSlip(fast, [fast], 0.5), "a")?.playbackStart).toBe(2);
  });

  it("slides freely past the end when the source length is unknown", () => {
    const a = clip("a", 0, 2, { sourceDuration: undefined });
    expect(changeOf(resolveSlip(a, [a], -20), "a")?.playbackStart).toBe(22);
  });

  it("moves linked partners by the same amount, within the tighter source", () => {
    const video = clip("v", 0, 3, { link: "lk-1" });
    const audio = clip("a", 0, 3, { link: "lk-1", kind: "audio", tag: "audio", sourceDuration: 6 });
    const members = slipMembers(video, [video, audio, clip("x", 0, 1)]);
    expect(members.map((m) => m.id)).toEqual(["v", "a"]);
    const result = resolveSlip(video, members, -5);
    // The audio's 6s source caps the in-point at 3s for both.
    expect(result.changes.map((c) => c.playbackStart)).toEqual([3, 3]);
  });

  it("only applies to clips with a source", () => {
    expect(canSlip(clip("a", 0, 1))).toBe(true);
    expect(canSlip(clip("i", 0, 1, { kind: "image", tag: "img" }))).toBe(false);
    expect(canSlip(clip("l", 0, 1, { timelineLocked: true }))).toBe(false);
  });

  it("reports no change for a drag that ends where it began", () => {
    const a = clip("a", 0, 1);
    expect(resolveSlip(a, [a], 0).hasChanged).toBe(false);
  });
});

describe("roll", () => {
  const left = clip("l", 0, 2, { playbackStart: 1 });
  const right = clip("r", 2, 3, { playbackStart: 4 });

  it("moves the edit point and keeps the pair's total length", () => {
    const result = resolveRoll(left, left, right, 0.5);
    expect(changeOf(result, "l")).toMatchObject({ start: 0, duration: 2.5, playbackStart: 1 });
    expect(changeOf(result, "r")).toMatchObject({ start: 2.5, duration: 2.5, playbackStart: 4.5 });
  });

  it("rolls back to earlier source on the right clip", () => {
    const result = resolveRoll(right, left, right, -1);
    expect(changeOf(result, "l")?.duration).toBe(1);
    expect(changeOf(result, "r")).toMatchObject({ start: 1, duration: 4, playbackStart: 3 });
  });

  it("is bounded by both clips' sources and minimum lengths", () => {
    // Left: 10s source from 1s in, 2s shown: 7s more. Right: 3s long, 0.1s minimum.
    expect(rollDeltaBounds(left, right).max).toBeCloseTo(2.9);
    // Right: in-point 4s can move back 4s; left: 2s long, so 1.9s.
    expect(rollDeltaBounds(left, right).min).toBeCloseTo(-1.9);
    const shortSource = clip("l", 0, 2, { playbackStart: 7.5, sourceDuration: 10 });
    expect(rollDeltaBounds(shortSource, right).max).toBeCloseTo(0.5);
  });

  it("leaves an image's missing in-point alone", () => {
    const still = clip("i", 2, 3, {
      kind: "image",
      tag: "img",
      playbackStart: undefined,
      sourceDuration: undefined,
    });
    const result = resolveRoll(left, left, still, 1);
    expect(changeOf(result, "i")).toMatchObject({
      start: 3,
      duration: 2,
      playbackStart: undefined,
    });
  });

  it("finds the clip touching an edge on the same track only", () => {
    const other = clip("o", 2, 1, { track: 1 });
    expect(findRollPartner(left, "end", [left, right, other])?.id).toBe("r");
    expect(findRollPartner(right, "start", [left, right])?.id).toBe("l");
    expect(findRollPartner(right, "end", [left, right])).toBeNull();
    expect(findRollPartner(clip("g", 5.5, 1), "start", [left, right])).toBeNull();
  });

  it("does not roll linked clips, which would leave their partner out of sync", () => {
    const linked = clip("r", 2, 3, { link: "lk-2" });
    expect(findRollPartner(left, "end", [left, linked])).toBeNull();
  });
});

describe("previewSlipRoll", () => {
  it("turns pointer pixels and scroll into a slip", () => {
    const a = clip("a", 1, 3);
    const preview = previewSlipRoll(
      { mode: "slip", element: a, edge: "start", originClientX: 100, originScrollLeft: 0 },
      140,
      { scrollLeft: 10, pps: 100, elements: [a] },
    );
    expect(preview?.previewPlaybackStart).toBe(1.5);
    expect(preview?.groupPreview).toHaveLength(1);
  });

  it("previews a roll from either clip of the pair, and nothing once the partner is gone", () => {
    const left = clip("l", 0, 2);
    const right = clip("r", 2, 3);
    const roll = {
      mode: "roll" as const,
      element: right,
      edge: "start" as const,
      originClientX: 0,
      rollPartnerKey: "l",
    };
    const context = { scrollLeft: 0, pps: 100, elements: [left, right] };
    expect(previewSlipRoll(roll, -50, context)).toMatchObject({
      previewStart: 1.5,
      previewDuration: 3.5,
    });
    expect(previewSlipRoll(roll, -50, { ...context, elements: [right] })).toBeNull();
  });
});
