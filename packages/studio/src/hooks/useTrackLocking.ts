import { useCallback, useEffect } from "react";
import { usePlayerStore } from "../player";
import { useTrackControlsStore } from "../player/store/trackControlsStore";
import { trackLockRefusal } from "../player/components/trackLockSolo";
import type { CanEditTimelineElement } from "./timelineEditPermission";
import { useTimelineTrackVisibilityEditing } from "./timelineTrackVisibility";

/**
 * Track lock: registers the saving toggle the track headers press, and returns the host's
 * `canEdit` with locked tracks refused first, so every gated edit (move, trim, split, delete,
 * slip, roll, drops onto the track, effects) stops at a locked track with one reason.
 */
export function useTrackLocking(
  input: Parameters<typeof useTimelineTrackVisibilityEditing>[0],
  canEdit: CanEditTimelineElement | undefined,
): CanEditTimelineElement {
  const toggleLocked = useTimelineTrackVisibilityEditing({ ...input, flag: "timelineLocked" });
  useEffect(() => {
    const { setToggleLocked } = useTrackControlsStore.getState();
    setToggleLocked(
      (track, locked, displayNumber) => void toggleLocked(track, locked, displayNumber),
    );
    return () => setToggleLocked(null);
  }, [toggleLocked]);
  return useCallback(
    (element) => {
      const reason = trackLockRefusal(element, usePlayerStore.getState().elements);
      return reason ? { blocked: true, reason } : (canEdit?.(element) ?? true);
    },
    [canEdit],
  );
}
