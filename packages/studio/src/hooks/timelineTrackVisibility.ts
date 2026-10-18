import { useCallback } from "react";
import { usePlayerStore, type TimelineElement } from "../player";
import { reseekPreviewAtTime } from "../player/hooks/timelineSyncHydration";
import { applySoftReloadFinalization } from "../utils/gsapSoftReload";
import {
  timelineTrackOrder,
  trackDisplayNumber,
  trackDisplaySuffix,
} from "../player/components/timelineTrackDisplay";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import { isAudioOnlyTrack } from "../utils/timelineInspector";
import { hiddenToggleVerb } from "../player/components/hiddenToggle";
import type { PatchOperation } from "../utils/sourcePatcher";
import {
  findTimelineElementInIframe,
  operationChanges,
  patchTimelineChangesInSource,
  readFileContent,
  type RecordEditInput,
} from "./timelineEditingHelpers";

/** The boolean clip attributes a track header toggles across every clip on the track. */
type TrackFlag = "hidden" | "timelineLocked";

const TRACK_FLAGS: Record<TrackFlag, { attr: string; property: string; reseek: boolean }> = {
  // Hiding changes what the preview shows and plays, so the runtime re-seeks.
  hidden: { attr: "data-hidden", property: "hidden", reseek: true },
  // A lock changes only what Studio lets you edit.
  timelineLocked: { attr: "data-timeline-locked", property: "timeline-locked", reseek: false },
};

export interface MutableRef<T> {
  current: T;
}

interface ReadonlyRef<T> {
  readonly current: T;
}

interface ToggleTimelineTrackHiddenInput {
  /** Which attribute the toggle writes; hiding unless a lock asks otherwise. */
  flag?: TrackFlag;
  projectId: string;
  activeCompPath: string | null;
  timelineElements: readonly TimelineElement[];
  track: number;
  hidden: boolean;
  /** The row the CLICKED control announced. Absent when the caller has no
   *  rendered number to hand over, which falls back to deriving one. */
  displayNumber?: number | null;
  previewIframe: HTMLIFrameElement | null;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  pendingTimelineEditPathRef: MutableRef<Set<string>>;
}

interface ToggleTimelineElementHiddenInput extends Omit<ToggleTimelineTrackHiddenInput, "track"> {
  /** One timeline key, or several to hide/show in a single atomic file write. */
  elementKey: string | readonly string[];
}

interface SetElementsHiddenInput {
  flag?: TrackFlag;
  projectId: string;
  activeCompPath: string | null;
  elements: readonly TimelineElement[];
  hidden: boolean;
  label: string;
  previewIframe: HTMLIFrameElement | null;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  pendingTimelineEditPathRef: MutableRef<Set<string>>;
}

interface UseTimelineTrackVisibilityEditingInput extends Omit<
  ToggleTimelineTrackHiddenInput,
  "projectId" | "track" | "hidden" | "previewIframe"
> {
  projectIdRef: ReadonlyRef<string | null>;
  previewIframeRef: ReadonlyRef<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  isRecordingRef?: ReadonlyRef<boolean>;
  forceReloadSdkSession?: () => void;
}

export interface UseTimelineElementVisibilityEditingInput extends Omit<
  ToggleTimelineElementHiddenInput,
  "projectId" | "elementKey" | "hidden" | "previewIframe" | "timelineElements"
> {
  projectIdRef: ReadonlyRef<string | null>;
  previewIframeRef: ReadonlyRef<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  isRecordingRef?: ReadonlyRef<boolean>;
  forceReloadSdkSession?: () => void;
}

function getTimelineElementTargetPath(
  element: TimelineElement,
  activeCompPath: string | null,
): string {
  return element.sourceFile || activeCompPath || "index.html";
}

function patchLiveFlag(
  iframe: HTMLIFrameElement | null,
  elements: readonly TimelineElement[],
  attr: string,
  on: boolean,
  activeCompPath: string | null,
): void {
  for (const element of elements) {
    const target = findTimelineElementInIframe(iframe, element, activeCompPath);
    if (!target) continue;
    if (on) {
      target.setAttribute(attr, "");
    } else {
      target.removeAttribute(attr);
    }
  }
}

export function reseekPreviewRuntime(iframe: HTMLIFrameElement | null): void {
  const store = usePlayerStore.getState();
  if (applySoftReloadFinalization(iframe, store.currentTime)) return;
  reseekPreviewAtTime({ seek: store.requestSeek }, store.currentTime);
}

export function groupElementsByTargetPath(
  elements: readonly TimelineElement[],
  activeCompPath: string | null,
): Map<string, TimelineElement[]> {
  const byPath = new Map<string, TimelineElement[]>();
  for (const element of elements) {
    const targetPath = getTimelineElementTargetPath(element, activeCompPath);
    const existing = byPath.get(targetPath);
    if (existing) {
      existing.push(element);
    } else {
      byPath.set(targetPath, [element]);
    }
  }
  return byPath;
}

// fallow-ignore-next-line complexity
async function setElementsHidden({
  flag = "hidden",
  projectId,
  activeCompPath,
  elements,
  hidden,
  label,
  previewIframe,
  writeProjectFile,
  recordEdit,
  pendingTimelineEditPathRef,
}: SetElementsHiddenInput): Promise<string[]> {
  if (elements.length === 0) return [];
  const config = TRACK_FLAGS[flag];
  const applyLive = (on: boolean) => {
    patchLiveFlag(previewIframe, elements, config.attr, on, activeCompPath);
    if (config.reseek) reseekPreviewRuntime(previewIframe);
  };
  applyLive(hidden);

  const hiddenOperation: PatchOperation = {
    type: "attribute",
    property: config.property,
    value: hidden ? "" : null,
  };
  const files: Record<string, (current: string) => string> = {};
  for (const [targetPath, fileElements] of groupElementsByTargetPath(elements, activeCompPath)) {
    files[targetPath] = (current) => {
      pendingTimelineEditPathRef.current.add(targetPath);
      return patchTimelineChangesInSource(
        current,
        targetPath,
        operationChanges(fileElements, hiddenOperation),
      );
    };
  }

  try {
    const changedPaths = await saveProjectFilesWithHistory({
      projectId,
      label,
      files,
      readFile: (path) => readFileContent(projectId, path),
      writeFile: writeProjectFile,
      recordEdit,
    });
    for (const element of elements) {
      usePlayerStore.getState().updateElement(element.key ?? element.id, { [flag]: hidden });
    }
    return changedPaths;
  } catch (error) {
    // The optimistic live patch already ran; a patch-target/save failure here would
    // otherwise leave the preview showing the wrong visibility until a reload. Revert
    // the live DOM to the prior state so what's on screen matches what persisted.
    applyLive(!hidden);
    throw error;
  }
}

export async function toggleTimelineTrackHidden({
  flag = "hidden",
  projectId,
  activeCompPath,
  timelineElements,
  track,
  hidden,
  displayNumber,
  previewIframe,
  writeProjectFile,
  recordEdit,
  pendingTimelineEditPathRef,
}: ToggleTimelineTrackHiddenInput): Promise<string[]> {
  // `track` is the fractional sort key the callback needs; the history entry is
  // read by a human, so it gets the display row instead — the one the clicked
  // control announced, when the caller passed it. Deriving it again here would
  // use ascending element-bearing keys, which stop matching the header as soon
  // as an audio group reorders the rows and inserts an anchor: the same click
  // then said "Mute track 2" and recorded "Mute track 1".
  const suffix = trackDisplaySuffix(
    displayNumber ?? trackDisplayNumber(timelineTrackOrder(timelineElements), track),
  );
  const trackElements = timelineElements.filter((element) => element.track === track);
  const hiddenBefore = !hidden;
  const verb =
    flag === "timelineLocked"
      ? hidden
        ? "Lock"
        : "Unlock"
      : hiddenToggleVerb(isAudioOnlyTrack(trackElements), hiddenBefore);
  return setElementsHidden({
    flag,
    label: `${verb} track${suffix}`,
    projectId,
    activeCompPath,
    elements: trackElements,
    hidden,
    previewIframe,
    writeProjectFile,
    recordEdit,
    pendingTimelineEditPathRef,
  });
}

export async function toggleTimelineElementHidden({
  projectId,
  activeCompPath,
  timelineElements,
  elementKey,
  hidden,
  previewIframe,
  writeProjectFile,
  recordEdit,
  pendingTimelineEditPathRef,
}: ToggleTimelineElementHiddenInput): Promise<string[]> {
  const keys = new Set(typeof elementKey === "string" ? [elementKey] : elementKey);
  const elements = timelineElements.filter((item) => keys.has(item.key ?? item.id));
  const hiddenBefore = !hidden;
  const verb = hiddenToggleVerb(isAudioOnlyTrack(elements), hiddenBefore);
  return setElementsHidden({
    projectId,
    activeCompPath,
    elements,
    hidden,
    label: elements.length > 1 ? `${verb} ${elements.length} elements` : `${verb} element`,
    previewIframe,
    writeProjectFile,
    recordEdit,
    pendingTimelineEditPathRef,
  });
}

export function useTimelineTrackVisibilityEditing({
  flag = "hidden",
  projectIdRef,
  activeCompPath,
  showToast,
  writeProjectFile,
  recordEdit,
  previewIframeRef,
  pendingTimelineEditPathRef,
  isRecordingRef,
  forceReloadSdkSession,
}: UseTimelineTrackVisibilityEditingInput): (
  track: number,
  hidden: boolean,
  displayNumber?: number | null,
) => Promise<void> {
  // Resolve the eye toggle against the EXPANDED rows the canvas actually renders:
  // virtual sub-comp children carry their own (display.track + idx) track numbers,
  // so filtering the raw store list by a virtual track number would hide the wrong
  // outer-scene sibling sharing that index.
  const timelineElements = usePlayerStore((state) => state.elements);
  return useCallback(
    async (track: number, hidden: boolean, displayNumber?: number | null) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;
      try {
        await toggleTimelineTrackHidden({
          flag,
          projectId: pid,
          activeCompPath,
          timelineElements,
          track,
          hidden,
          displayNumber,
          previewIframe: previewIframeRef.current,
          writeProjectFile,
          recordEdit,
          pendingTimelineEditPathRef,
        });
        forceReloadSdkSession?.();
      } catch (error) {
        const what = flag === "timelineLocked" ? "lock" : "visibility";
        console.error(`[Timeline] Failed to toggle track ${what}`, error);
        const message = error instanceof Error ? error.message : `Failed to toggle track ${what}`;
        showToast(message);
      }
    },
    [
      flag,
      activeCompPath,
      timelineElements,
      previewIframeRef,
      writeProjectFile,
      recordEdit,
      pendingTimelineEditPathRef,
      isRecordingRef,
      showToast,
      forceReloadSdkSession,
      projectIdRef,
    ],
  );
}

export function useTimelineElementVisibilityEditing({
  projectIdRef,
  activeCompPath,
  showToast,
  writeProjectFile,
  recordEdit,
  previewIframeRef,
  pendingTimelineEditPathRef,
  isRecordingRef,
  forceReloadSdkSession,
}: UseTimelineElementVisibilityEditingInput): (
  elementKey: string | readonly string[],
  hidden: boolean,
) => Promise<void> {
  const timelineElements = usePlayerStore((state) => state.elements);
  return useCallback(
    async (elementKey: string | readonly string[], hidden: boolean) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;
      const keys = typeof elementKey === "string" ? [elementKey] : elementKey;
      if (!timelineElements.some((item) => keys.includes(item.key ?? item.id))) {
        showToast("This element is inside a sub-composition and has no timeline row to hide.");
        return;
      }
      try {
        await toggleTimelineElementHidden({
          projectId: pid,
          activeCompPath,
          timelineElements,
          elementKey,
          hidden,
          previewIframe: previewIframeRef.current,
          writeProjectFile,
          recordEdit,
          pendingTimelineEditPathRef,
        });
        forceReloadSdkSession?.();
      } catch (error) {
        console.error("[Timeline] Failed to toggle element visibility", error);
        const message =
          error instanceof Error ? error.message : "Failed to toggle element visibility";
        showToast(message);
      }
    },
    [
      activeCompPath,
      timelineElements,
      previewIframeRef,
      writeProjectFile,
      recordEdit,
      pendingTimelineEditPathRef,
      isRecordingRef,
      showToast,
      forceReloadSdkSession,
      projectIdRef,
    ],
  );
}
