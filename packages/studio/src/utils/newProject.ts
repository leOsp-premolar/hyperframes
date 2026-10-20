import { studioApiFetch } from "./studioApiFetch";

/** Starting frame sizes offered in the New project form. Every side is even, as H.264 needs. */
export const RESOLUTION_PRESETS = [
  { value: "1920x1080", label: "Landscape 1080p · 1920 × 1080", width: 1920, height: 1080 },
  { value: "1280x720", label: "Landscape 720p · 1280 × 720", width: 1280, height: 720 },
  { value: "3840x2160", label: "Landscape 4K · 3840 × 2160", width: 3840, height: 2160 },
  { value: "1080x1920", label: "Vertical · 1080 × 1920", width: 1080, height: 1920 },
  { value: "1080x1350", label: "Portrait 4:5 · 1080 × 1350", width: 1080, height: 1350 },
  { value: "1080x1080", label: "Square · 1080 × 1080", width: 1080, height: 1080 },
] as const;

export const CUSTOM_RESOLUTION = "custom";

export interface NewProjectDraft {
  name: string;
  width: number;
  height: number;
  durationSeconds: number;
  /** Left out for the server's default (black). */
  background?: string;
}

export type NewProjectOutcome =
  | { ok: true; id: string }
  /** `existingId` is set when the name is taken, so the form can offer to open that project. */
  | { ok: false; error: string; existingId?: string };

function readError(body: unknown): { error?: string; id?: string } {
  if (typeof body !== "object" || body === null) return {};
  const error = "error" in body && typeof body.error === "string" ? body.error : undefined;
  const id = "id" in body && typeof body.id === "string" ? body.id : undefined;
  return { error, id };
}

function readCreatedId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("project" in body)) return null;
  const { project } = body;
  if (typeof project !== "object" || project === null || !("id" in project)) return null;
  return typeof project.id === "string" ? project.id : null;
}

/** Ask the server to create the project. The server owns every naming and size rule. */
export async function requestNewProject(draft: NewProjectDraft): Promise<NewProjectOutcome> {
  let res: Response;
  try {
    res = await studioApiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
  } catch {
    return { ok: false, error: "Studio could not reach its server. Check that it is running." };
  }
  const body: unknown = await res.json().catch(() => null);
  const id = readCreatedId(body);
  if (res.ok && id) return { ok: true, id };
  const detail = readError(body);
  return {
    ok: false,
    error: detail.error ?? `The project could not be created (HTTP ${res.status}).`,
    ...(res.status === 409 && detail.id ? { existingId: detail.id } : {}),
  };
}
