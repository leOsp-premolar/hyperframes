import type { TimelineElement } from "../store/playerStore";

export const TRACK_LOCKED_REASON = "This track is locked. Unlock it to edit its clips.";

/** A track is locked when every clip on it is (`data-timeline-locked`). */
export function isTrackLocked(elements: readonly TimelineElement[]): boolean {
  return elements.length > 0 && elements.every((element) => element.timelineLocked === true);
}

/** Whether a clip can be heard: audio, or a video or composition not marked silent. */
export function hasSound(element: TimelineElement): boolean {
  if (element.muted) return false;
  if (element.kind === "audio" || element.tag.toLowerCase() === "audio") return true;
  if (element.kind === "video" || element.kind === "composition") return element.hasAudio !== false;
  return false;
}

/** The clips a solo silences: everything with sound off the soloed tracks. None without a solo. */
export function soloSilencedElements(
  elements: readonly TimelineElement[],
  soloTracks: ReadonlySet<number>,
): TimelineElement[] {
  if (soloTracks.size === 0) return [];
  return elements.filter((element) => hasSound(element) && !soloTracks.has(element.track));
}

/**
 * Why an edit of `element` is refused for a locked track, or null when its track is not locked.
 * The track is judged without the clip itself, which a drag may already show on it.
 */
export function trackLockRefusal(
  element: Pick<TimelineElement, "track" | "timelineLocked"> & { id?: string; key?: string },
  elements: readonly TimelineElement[],
): string | null {
  const self = element.key ?? element.id;
  const locked =
    element.timelineLocked === true ||
    isTrackLocked(
      elements.filter(
        (other) =>
          other.track === element.track && (self === undefined || (other.key ?? other.id) !== self),
      ),
    );
  return locked ? TRACK_LOCKED_REASON : null;
}

/**
 * The clips a move checks: each clip and, when the timeline already shows it on another track
 * (a drag lands it there before saving), that track too, so a lock on either refuses the move.
 */
export function moveTargets(
  moved: readonly TimelineElement[],
  elements: readonly TimelineElement[],
): TimelineElement[] {
  const keyOf = (element: TimelineElement) => element.key ?? element.id;
  return moved.flatMap((element) => {
    const shown = elements.find((other) => keyOf(other) === keyOf(element));
    return shown && shown.track !== element.track ? [element, shown] : [element];
  });
}
