import { useTrackControlsStore } from "../store/trackControlsStore";
import type { TimelineElement } from "../store/playerStore";
import { trackDisplaySuffix } from "./timelineTrackDisplay";
import { hasSound, isTrackLocked } from "./trackLockSolo";

const BUTTON_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded border-0 bg-transparent p-0 transition-colors focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--timeline-accent)]";
const ON = "text-[var(--timeline-accent)] hover:text-[var(--timeline-text-solid)]";
const OFF = "text-[var(--timeline-text-faint)] hover:text-[var(--timeline-text-soft)]";

function PadlockIcon({ locked }: { locked: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d={locked ? "M5.5 7V5a2.5 2.5 0 015 0v2" : "M5.5 7V5a2.5 2.5 0 014.9-.7"} />
    </svg>
  );
}

/**
 * Lock and solo for one track. Lock saves with the project and stops every edit of the track's
 * clips; solo lives in this session's preview only and silences every other track with sound.
 */
export function TrackLockSoloButtons({
  trackNumber,
  trackDisplayNumber,
  trackElements,
}: {
  trackNumber: number;
  trackDisplayNumber: number | null;
  trackElements: readonly TimelineElement[];
}) {
  const toggleLocked = useTrackControlsStore((s) => s.toggleLocked);
  const soloed = useTrackControlsStore((s) => s.soloTracks.has(trackNumber));
  const toggleSolo = useTrackControlsStore((s) => s.toggleSolo);
  const locked = isTrackLocked(trackElements);
  const suffix = trackDisplaySuffix(trackDisplayNumber);
  const lockLabel = `${locked ? "Unlock" : "Lock"} track${suffix}`;
  const soloLabel = `${soloed ? "Unsolo" : "Solo"} track${suffix}`;
  return (
    <>
      {trackElements.some(hasSound) && (
        <button
          type="button"
          aria-label={soloLabel}
          aria-pressed={soloed}
          title={`${soloLabel} (preview only)`}
          className={`${BUTTON_CLASS} text-[10px] font-semibold ${soloed ? ON : OFF}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleSolo(trackNumber);
          }}
        >
          S
        </button>
      )}
      {toggleLocked && (
        <button
          type="button"
          aria-label={lockLabel}
          aria-pressed={locked}
          title={lockLabel}
          className={`${BUTTON_CLASS} ${locked ? ON : OFF}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleLocked(trackNumber, !locked, trackDisplayNumber);
          }}
        >
          <PadlockIcon locked={locked} />
        </button>
      )}
    </>
  );
}
