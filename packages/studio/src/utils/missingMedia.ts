import { create } from "zustand";
import type { TimelineElement } from "../player/store/timelineElement";
import { buildProjectApiPath } from "./projectRouting";
import { studioApiFetch } from "./studioApiFetch";

/** A file the compositions name that cannot be played, as `/media/missing` reports it. */
export interface MissingMediaEntry {
  path: string;
  kind: "video" | "image" | "audio";
  reason: "missing" | "unreadable" | "not-a-file";
  /** The ids of the clips that use it, where they have one. */
  clipIds: string[];
  /** How many elements name it, ids or not. */
  uses: number;
}

const KINDS = ["video", "image", "audio"] as const;
const REASONS = ["missing", "unreadable", "not-a-file"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | null {
  return options.find((option) => option === value) ?? null;
}

function parseEntry(value: unknown): MissingMediaEntry | null {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  const kind = oneOf(KINDS, value.kind);
  const reason = oneOf(REASONS, value.reason);
  if (!kind || !reason) return null;
  const references = Array.isArray(value.references) ? value.references : [];
  const clipIds = references.flatMap((ref) =>
    isRecord(ref) && typeof ref.id === "string" ? [ref.id] : [],
  );
  return { path: value.path, kind, reason, clipIds, uses: references.length };
}

/** The endpoint's answer as entries; anything it cannot read is dropped. */
export function parseMissingMedia(body: unknown): MissingMediaEntry[] {
  const list = isRecord(body) && Array.isArray(body.missing) ? body.missing : [];
  return list.flatMap((entry) => parseEntry(entry) ?? []);
}

export async function fetchMissingMedia(projectId: string): Promise<MissingMediaEntry[] | null> {
  try {
    const res = await studioApiFetch(buildProjectApiPath(projectId, "/media/missing"));
    return res.ok ? parseMissingMedia(await res.json()) : null;
  } catch {
    return null;
  }
}

export type ReplaceOutcome =
  | { ok: true; path: string; warnings: string[] }
  | { ok: false; error: string };

/** Upload `file` in place of the missing `path`; the server changes nothing unless it all works. */
export async function requestMediaReplacement(
  projectId: string,
  path: string,
  file: File,
): Promise<ReplaceOutcome> {
  const form = new FormData();
  form.append("file", file);
  const url = buildProjectApiPath(projectId, `/media/replace?path=${encodeURIComponent(path)}`);
  let res: Response;
  try {
    res = await studioApiFetch(url, { method: "POST", body: form });
  } catch {
    return { ok: false, error: `Could not replace ${path}: the server did not answer` };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body) || typeof body.path !== "string") {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : null;
    return { ok: false, error: error ?? `Could not replace ${path} (${res.status})` };
  }
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.filter((w): w is string => typeof w === "string")
    : [];
  return { ok: true, path: body.path, warnings };
}

/** The project path a clip's media plays from: the store holds preview URLs. */
export function clipMediaPath(element: Pick<TimelineElement, "src">): string | null {
  if (!element.src) return null;
  const path = element.src
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/api\/projects\/[^/]+\/preview\//, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

interface MissingMediaState {
  missing: readonly MissingMediaEntry[];
  /** Opens the file picker for one missing path; null until Studio has a project. */
  replace: ((path: string) => void) | null;
  set: (missing: readonly MissingMediaEntry[], replace: ((path: string) => void) | null) => void;
}

/** What is missing right now, shared by the banner, the clip badges and the clip menu. */
export const useMissingMediaStore = create<MissingMediaState>((set) => ({
  missing: [],
  replace: null,
  set: (missing, replace) => set({ missing, replace }),
}));

/** The missing file a clip plays, matched by its id or by where its media points. */
export function missingMediaFor(
  missing: readonly MissingMediaEntry[],
  element: Pick<TimelineElement, "src" | "domId" | "id">,
): MissingMediaEntry | null {
  if (missing.length === 0) return null;
  const path = clipMediaPath(element);
  const id = element.domId ?? element.id;
  return (
    missing.find((entry) => entry.path === path) ??
    missing.find((entry) => entry.clipIds.includes(id)) ??
    null
  );
}
