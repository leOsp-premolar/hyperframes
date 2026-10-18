import { useState } from "react";
import { useMissingMediaStore, type MissingMediaEntry } from "../utils/missingMedia";

const SHOWN = 3;

function why(entry: MissingMediaEntry): string {
  if (entry.reason === "unreadable") return "can't be read";
  if (entry.reason === "not-a-file") return "is a folder, not a file";
  return "is missing";
}

function uses(entry: MissingMediaEntry): string {
  return entry.uses === 1 ? "1 clip" : `${entry.uses} clips`;
}

/**
 * Names the media files the project's clips point at but cannot play, with a way to replace each.
 * Hiding it lasts until the list changes; the clip badges still mark what is missing.
 */
export function MissingMediaBanner() {
  const missing = useMissingMediaStore((s) => s.missing);
  const replace = useMissingMediaStore((s) => s.replace);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const key = missing.map((entry) => entry.path).join("\n");
  if (missing.length === 0 || hiddenFor === key) return null;
  const extra = missing.length - SHOWN;
  return (
    <div
      role="status"
      data-testid="missing-media-banner"
      className="hf-backdrop-in absolute left-1/2 top-14 z-92 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-950/85 px-4 py-2 text-[12px] text-amber-100 shadow-lg shadow-black/30"
    >
      <div className="flex items-center gap-3">
        <span className="font-medium">
          {missing.length === 1
            ? "1 media file can't be played. Its clips stay in place, empty, until you replace it."
            : `${missing.length} media files can't be played. Their clips stay in place, empty, until you replace them.`}
        </span>
        <button
          type="button"
          className="ml-auto text-amber-200/70 hover:text-amber-100"
          onClick={() => setHiddenFor(key)}
        >
          Hide
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {missing.slice(0, SHOWN).map((entry) => (
          <li key={entry.path} className="flex items-center gap-2" data-missing-path={entry.path}>
            <strong className="min-w-0 truncate font-mono" title={entry.path}>
              {entry.path}
            </strong>
            <span className="shrink-0 text-amber-200/70">
              {why(entry)}, used by {uses(entry)}
            </span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded border border-amber-400/40 px-2 py-0.5 hover:bg-amber-400/15 disabled:opacity-50"
              disabled={!replace}
              onClick={() => replace?.(entry.path)}
            >
              Replace…
            </button>
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <span className="text-amber-200/70">
          {extra} more; right-click a clip marked Missing to replace it.
        </span>
      )}
    </div>
  );
}
