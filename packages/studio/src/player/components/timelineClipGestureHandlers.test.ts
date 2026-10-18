// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { createClipGestureHandlers, type ClipGestureDeps } from "./timelineClipGestureHandlers";

afterEach(() => usePlayerStore.getState().reset());

const clips: TimelineElement[] = Array.from({ length: 6 }, (_, i) => ({
  id: `clip-${i}`,
  domId: `clip-${i}`,
  tag: "div",
  start: i,
  duration: 1,
  track: i,
}));
const capabilities = { canMove: true, canTrimStart: true, canTrimEnd: true, readOnly: false };

function grabFirstClip(count: number, gesture: "move" | "resize") {
  const store = usePlayerStore.getState();
  store.setElements(clips);
  store.setSelectedElementIds(new Set(clips.slice(0, count).map((c) => c.id)));
  const setDraggedClip = vi.fn();
  const setResizingClip = vi.fn();
  const blockedClipRef = { current: null as { intent: string } | null };
  const deps = {
    pps: 100,
    onMoveElement: vi.fn(),
    onResizeElement: vi.fn(),
    blockedClipRef,
    suppressClickRef: { current: false },
    scrollRef: { current: null },
    setShowPopover: vi.fn(),
    setRangeSelection: vi.fn(),
    setResizingClip,
    setDraggedClip,
    setSelectedElementId: vi.fn(),
  } as unknown as ClipGestureDeps;
  const handlers = createClipGestureHandlers(clips[0], clips[0].id, clips[0], capabilities, deps);
  const event = {
    button: 0,
    clientX: 50,
    clientY: 5,
    pointerId: 1,
    stopPropagation: vi.fn(),
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) },
  } as unknown as ReactPointerEvent;
  if (gesture === "move") handlers.onPointerDown(event);
  else handlers.onResizeStart("end", event);
  return { setDraggedClip, setResizingClip, blockedClipRef };
}

describe("hand-editing a multi-selection", () => {
  it.each([1, 3, 4, 6])("moves %i selected clips by hand", (count) => {
    const { setDraggedClip, blockedClipRef } = grabFirstClip(count, "move");
    expect(setDraggedClip).toHaveBeenCalledOnce();
    expect(blockedClipRef.current).toBeNull();
  });

  it.each([1, 3, 4, 6])("resizes %i selected clips by hand", (count) => {
    const { setResizingClip, blockedClipRef } = grabFirstClip(count, "resize");
    expect(setResizingClip).toHaveBeenCalledOnce();
    expect(blockedClipRef.current).toBeNull();
  });
});

describe("slip and roll tools", () => {
  const video = (
    id: string,
    start: number,
    extra: Partial<TimelineElement> = {},
  ): TimelineElement => ({
    id,
    key: id,
    domId: id,
    tag: "video",
    kind: "video",
    start,
    duration: 2,
    track: 0,
    playbackStart: 1,
    ...extra,
  });

  function press(
    tool: "slip" | "roll",
    target: TimelineElement,
    elements: TimelineElement[],
    where: "body" | "start" | "end",
  ) {
    usePlayerStore.getState().setElements(elements);
    usePlayerStore.getState().setActiveTool(tool);
    const setResizingClip = vi.fn();
    const setDraggedClip = vi.fn();
    const deps = {
      pps: 100,
      onMoveElement: vi.fn(),
      onResizeElement: vi.fn(),
      blockedClipRef: { current: null },
      suppressClickRef: { current: false },
      scrollRef: { current: null },
      setShowPopover: vi.fn(),
      setRangeSelection: vi.fn(),
      setResizingClip,
      setDraggedClip,
      setSelectedElementId: vi.fn(),
    } as unknown as ClipGestureDeps;
    const handlers = createClipGestureHandlers(target, target.id, target, capabilities, deps);
    const event = {
      button: 0,
      clientX: 50,
      clientY: 5,
      pointerId: 1,
      stopPropagation: vi.fn(),
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) },
    } as unknown as ReactPointerEvent;
    if (where === "body") handlers.onPointerDown(event);
    else handlers.onResizeStart(where, event);
    return { setResizingClip, setDraggedClip };
  }

  it("slips a media clip from anywhere on it, never moving it", () => {
    const a = video("a", 0);
    const { setResizingClip, setDraggedClip } = press("slip", a, [a], "body");
    expect(setResizingClip).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "slip", element: a }),
    );
    expect(setDraggedClip).not.toHaveBeenCalled();
  });

  it("has nothing to slip on a still image", () => {
    const still = video("i", 0, { kind: "image", tag: "img" });
    const { setResizingClip, setDraggedClip } = press("slip", still, [still], "body");
    expect(setResizingClip).not.toHaveBeenCalled();
    expect(setDraggedClip).not.toHaveBeenCalled();
  });

  it("rolls an edge that touches the next clip, and nothing else", () => {
    const left = video("l", 0);
    const right = video("r", 2);
    const roll = press("roll", left, [left, right], "end");
    expect(roll.setResizingClip).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "roll", rollPartnerKey: "r", edge: "end" }),
    );
    expect(press("roll", left, [left, right], "start").setResizingClip).not.toHaveBeenCalled();
    const body = press("roll", left, [left, right], "body");
    expect(body.setResizingClip).not.toHaveBeenCalled();
    expect(body.setDraggedClip).not.toHaveBeenCalled();
  });
});
