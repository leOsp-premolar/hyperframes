import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import {
  hasSound,
  isTrackLocked,
  moveTargets,
  soloSilencedElements,
  trackLockRefusal,
} from "./trackLockSolo";

function clip(id: string, track: number, extra: Partial<TimelineElement> = {}): TimelineElement {
  return { id, tag: "div", start: 0, duration: 1, track, ...extra };
}

describe("isTrackLocked", () => {
  it("is locked only when the track has clips and every one is locked", () => {
    expect(isTrackLocked([])).toBe(false);
    expect(isTrackLocked([clip("a", 0, { timelineLocked: true })])).toBe(true);
    expect(isTrackLocked([clip("a", 0, { timelineLocked: true }), clip("b", 0)])).toBe(false);
  });
});

describe("hasSound", () => {
  it("hears audio, and video or compositions unless marked silent or muted", () => {
    expect(hasSound(clip("a", 0, { kind: "audio", tag: "audio" }))).toBe(true);
    expect(hasSound(clip("v", 0, { kind: "video", tag: "video" }))).toBe(true);
    expect(hasSound(clip("v", 0, { kind: "video", tag: "video", hasAudio: false }))).toBe(false);
    expect(hasSound(clip("c", 0, { kind: "composition" }))).toBe(true);
    expect(hasSound(clip("m", 0, { kind: "audio", tag: "audio", muted: true }))).toBe(false);
    expect(hasSound(clip("i", 0, { kind: "image", tag: "img" }))).toBe(false);
    expect(hasSound(clip("t", 0))).toBe(false);
  });
});

describe("soloSilencedElements", () => {
  const music = clip("music", 0, { kind: "audio", tag: "audio" });
  const voice = clip("voice", 1, { kind: "audio", tag: "audio" });
  const title = clip("title", 2);

  it("silences nothing without a solo", () => {
    expect(soloSilencedElements([music, voice, title], new Set())).toEqual([]);
  });

  it("silences every clip with sound off the soloed tracks", () => {
    expect(soloSilencedElements([music, voice, title], new Set([1])).map((e) => e.id)).toEqual([
      "music",
    ]);
    expect(soloSilencedElements([music, voice, title], new Set([0, 1]))).toEqual([]);
  });
});

describe("trackLockRefusal", () => {
  it("refuses a clip on a locked track and allows the rest", () => {
    const locked = clip("a", 0, { timelineLocked: true });
    const free = clip("b", 1);
    expect(trackLockRefusal(locked, [locked, free])).toMatch(/locked/);
    expect(trackLockRefusal(free, [locked, free])).toBeNull();
    // A drop onto a locked track is refused through its track alone.
    expect(trackLockRefusal({ track: 0 }, [locked, free])).toMatch(/locked/);
  });

  it("judges the track without the clip itself, which a drag may already show there", () => {
    const locked = clip("a", 0, { timelineLocked: true });
    const dragged = clip("b", 0);
    expect(trackLockRefusal(dragged, [locked, dragged])).toMatch(/locked/);
  });
});

describe("moveTargets", () => {
  it("adds the track the timeline already shows a dragged clip on", () => {
    const a = clip("a", 1);
    const locked = clip("l", 0, { timelineLocked: true });
    expect(moveTargets([a], [locked, a])).toEqual([a]);
    const shown = { ...a, track: 0 };
    const targets = moveTargets([a], [locked, shown]);
    expect(targets.map((t) => t.track)).toEqual([1, 0]);
    expect(targets.map((t) => trackLockRefusal(t, [locked, shown]))).toEqual([
      null,
      "This track is locked. Unlock it to edit its clips.",
    ]);
  });
});
