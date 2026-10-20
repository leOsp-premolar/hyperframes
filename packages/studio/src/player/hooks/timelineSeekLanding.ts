import type { PlaybackAdapter } from "../lib/playbackTypes";

/**
 * Where a seek to `requested` landed. The runtime moves a seek down onto its frame grid, so the
 * store keeps that frame, the one the preview shows, and a keyframe or split at the playhead
 * lands on it rather than between frames where the ruler was clicked. An adapter that has not
 * moved yet (or reports elsewhere) leaves the requested time.
 */
export function landedSeekTime(adapter: Pick<PlaybackAdapter, "getTime">, requested: number) {
  const landed = adapter.getTime();
  const onGrid = Number.isFinite(landed) && landed <= requested + 1e-6 && requested - landed < 0.1;
  return onGrid ? landed : requested;
}

/**
 * Pause on a frame: playback stops between frames, so seek to where it stopped (which the
 * runtime moves onto its frame grid) and return the frame the preview then shows.
 */
export function settleOnFrame(adapter: Pick<PlaybackAdapter, "getTime" | "seek">): number {
  const time = adapter.getTime();
  adapter.seek(time);
  return landedSeekTime(adapter, time);
}
