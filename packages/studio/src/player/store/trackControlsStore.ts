import { create } from "zustand";

type ToggleTrackLocked = (track: number, locked: boolean, displayNumber?: number | null) => void;

interface TrackControlsState {
  /**
   * Tracks soloed in the preview, by their timeline track key. While any is soloed, every other
   * track with sound is silent in the preview; the file and the export are untouched.
   */
  soloTracks: ReadonlySet<number>;
  toggleSolo: (track: number) => void;
  clearSolo: () => void;
  /** Saves a track's lock; registered by the timeline editing hook, null without a project. */
  toggleLocked: ToggleTrackLocked | null;
  setToggleLocked: (toggle: ToggleTrackLocked | null) => void;
}

export const useTrackControlsStore = create<TrackControlsState>((set) => ({
  soloTracks: new Set(),
  toggleSolo: (track) =>
    set((state) => {
      const next = new Set(state.soloTracks);
      if (next.has(track)) next.delete(track);
      else next.add(track);
      return { soloTracks: next };
    }),
  clearSolo: () => set({ soloTracks: new Set() }),
  toggleLocked: null,
  setToggleLocked: (toggleLocked) => set({ toggleLocked }),
}));
