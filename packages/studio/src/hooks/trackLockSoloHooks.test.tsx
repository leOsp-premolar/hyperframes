// @vitest-environment happy-dom

import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_SOLO_SILENCED_ATTR } from "@hyperframes/core/studio-preview-mark";
import { usePlayerStore, type TimelineElement } from "../player";
import { useTrackControlsStore } from "../player/store/trackControlsStore";
import { mountReactHarness } from "./domSelectionTestHarness";
import type { CanEditTimelineElement } from "./timelineEditPermission";
import { useTrackLocking } from "./useTrackLocking";
import { useTrackSoloPreview } from "./useTrackSoloPreview";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  usePlayerStore.getState().reset();
  useTrackControlsStore.setState({ soloTracks: new Set(), toggleLocked: null });
  document.body.innerHTML = "";
});

function clip(id: string, track: number, extra: Partial<TimelineElement> = {}): TimelineElement {
  return { id, domId: id, tag: "audio", kind: "audio", start: 0, duration: 2, track, ...extra };
}

describe("useTrackLocking", () => {
  function mount(canEdit?: CanEditTimelineElement) {
    const result: { current: CanEditTimelineElement | null } = { current: null };
    function Harness() {
      result.current = useTrackLocking(
        {
          projectIdRef: { current: "p" },
          activeCompPath: "index.html",
          timelineElements: [],
          previewIframeRef: { current: null },
          showToast: vi.fn(),
          writeProjectFile: vi.fn(),
          recordEdit: vi.fn(),
          pendingTimelineEditPathRef: { current: new Set() },
        },
        canEdit,
      );
      return null;
    }
    root = mountReactHarness(<Harness />);
    return result;
  }

  it("refuses every clip of a locked track before asking the host", () => {
    const locked = clip("a", 0, { timelineLocked: true });
    const free = clip("b", 1);
    usePlayerStore.getState().setElements([locked, free]);
    const host = vi.fn<CanEditTimelineElement>(() => true);
    const canEdit = mount(host);
    expect(canEdit.current?.(locked)).toEqual({
      blocked: true,
      reason: "This track is locked. Unlock it to edit its clips.",
    });
    expect(host).not.toHaveBeenCalled();
    expect(canEdit.current?.(free)).toBe(true);
    expect(host).toHaveBeenCalledWith(free);
  });

  it("registers the lock toggle while mounted", () => {
    mount();
    expect(useTrackControlsStore.getState().toggleLocked).toBeTypeOf("function");
    act(() => root?.unmount());
    root = null;
    expect(useTrackControlsStore.getState().toggleLocked).toBeNull();
  });
});

describe("useTrackSoloPreview", () => {
  function mountWithPreview(projectId = "p") {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument;
    if (doc) doc.body.innerHTML = `<audio id="music"></audio><audio id="voice"></audio>`;
    const ref = { current: iframe };
    function Harness({ project }: { project: string }) {
      useTrackSoloPreview(project, ref, "index.html");
      return null;
    }
    root = mountReactHarness(<Harness project={projectId} />);
    const marked = () =>
      [...(doc?.querySelectorAll(`[${STUDIO_SOLO_SILENCED_ATTR}]`) ?? [])].map((el) => el.id);
    return { marked, rerender: (project: string) => root?.render(<Harness project={project} />) };
  }

  it("marks the other tracks' sound silent while a track is soloed, and clears it", () => {
    usePlayerStore.getState().setElements([clip("music", 0), clip("voice", 1)]);
    const preview = mountWithPreview();
    expect(preview.marked()).toEqual([]);
    act(() => useTrackControlsStore.getState().toggleSolo(1));
    expect(preview.marked()).toEqual(["music"]);
    act(() => useTrackControlsStore.getState().toggleSolo(0));
    expect(preview.marked()).toEqual([]);
    act(() => useTrackControlsStore.getState().clearSolo());
    expect(preview.marked()).toEqual([]);
  });

  it("ends the solo when the project changes", () => {
    usePlayerStore.getState().setElements([clip("music", 0), clip("voice", 1)]);
    const preview = mountWithPreview();
    act(() => useTrackControlsStore.getState().toggleSolo(1));
    expect(preview.marked()).toEqual(["music"]);
    act(() => preview.rerender("other"));
    expect(useTrackControlsStore.getState().soloTracks.size).toBe(0);
    expect(preview.marked()).toEqual([]);
  });
});
