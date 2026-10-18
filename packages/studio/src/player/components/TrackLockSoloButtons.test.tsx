// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { useTrackControlsStore } from "../store/trackControlsStore";
import { TrackLockSoloButtons } from "./TrackLockSoloButtons";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  useTrackControlsStore.setState({ soloTracks: new Set(), toggleLocked: null });
  document.body.innerHTML = "";
});

function render(trackElements: TimelineElement[]) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TrackLockSoloButtons trackNumber={3} trackDisplayNumber={2} trackElements={trackElements} />,
    ),
  );
  return host;
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

const voice: TimelineElement = {
  id: "voice",
  tag: "audio",
  kind: "audio",
  start: 0,
  duration: 2,
  track: 3,
};

describe("TrackLockSoloButtons", () => {
  it("solos the track in the preview store and back", () => {
    const host = render([voice]);
    act(() => button(host, "Solo track 2")?.click());
    expect(useTrackControlsStore.getState().soloTracks.has(3)).toBe(true);
    const unsolo = button(host, "Unsolo track 2");
    expect(unsolo?.getAttribute("aria-pressed")).toBe("true");
    act(() => unsolo?.click());
    expect(useTrackControlsStore.getState().soloTracks.size).toBe(0);
  });

  it("offers no solo on a track without sound", () => {
    const host = render([{ ...voice, tag: "div", kind: "element" }]);
    expect(button(host, "Solo track 2")).toBeNull();
  });

  it("locks through the registered toggle, and unlocks a locked track", () => {
    const toggleLocked = vi.fn();
    useTrackControlsStore.setState({ toggleLocked });
    let host = render([voice]);
    act(() => button(host, "Lock track 2")?.click());
    expect(toggleLocked).toHaveBeenCalledWith(3, true, 2);
    act(() => root?.unmount());
    host = render([{ ...voice, timelineLocked: true }]);
    act(() => button(host, "Unlock track 2")?.click());
    expect(toggleLocked).toHaveBeenLastCalledWith(3, false, 2);
  });

  it("shows no lock until a project registers the toggle", () => {
    expect(button(render([voice]), "Lock track 2")).toBeNull();
  });
});
