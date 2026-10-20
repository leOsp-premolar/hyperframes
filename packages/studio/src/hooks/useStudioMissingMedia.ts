import { useCallback } from "react";
import { useStudioPlaybackContext, useStudioShellContext } from "../contexts/StudioContext";
import { useFileManagerContextOptional } from "../contexts/FileManagerContext";
import type { TimelineClipMenuItem } from "../player/components/TimelineTypes";
import type { TimelineElement } from "../player";
import { missingMediaFor, useMissingMediaStore } from "../utils/missingMedia";
import { useMissingMedia } from "./useMissingMedia";

/** Studio's wiring of the missing-media check; returns the clip menu entry that replaces a clip's file. */
export function useStudioMissingMedia(): (element: TimelineElement) => TimelineClipMenuItem[] {
  const { projectId, showToast } = useStudioShellContext();
  const { refreshKey, setRefreshKey } = useStudioPlaybackContext();
  const refreshFileTree = useFileManagerContextOptional()?.refreshFileTree;
  const onReplaced = useCallback(() => {
    void refreshFileTree?.();
    setRefreshKey((key) => key + 1);
  }, [refreshFileTree, setRefreshKey]);
  useMissingMedia({ projectId, refreshKey, showToast, onReplaced });

  return useCallback((element: TimelineElement) => {
    const { missing, replace } = useMissingMediaStore.getState();
    const entry = missingMediaFor(missing, element);
    if (!entry || !replace) return [];
    return [{ id: "replace-media", label: "Replace media…", onSelect: () => replace(entry.path) }];
  }, []);
}
