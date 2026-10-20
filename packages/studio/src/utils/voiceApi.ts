import { buildProjectApiPath } from "./projectRouting";
import { studioApiFetch } from "./studioApiFetch";

export interface VoiceProviderInfo {
  id: string;
  label: string;
  local: boolean;
  configured: boolean;
  setupHint?: string;
  defaultVoice: string;
  styleModels: string[];
  maxCharacters: number;
}

export interface VoiceProviders {
  auto: string;
  providers: VoiceProviderInfo[];
}

export interface VoiceOption {
  id: string;
  name: string;
  description?: string;
}

export interface VoiceDraft {
  text: string;
  provider: string;
  voice?: string;
  speed?: number;
  style?: string;
  language?: string;
}

export type VoiceOutcome =
  | { ok: true; path: string; provider: string; voice: string; durationSeconds: number }
  | { ok: false; error: string; code?: string };

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

const UNREACHABLE = "Studio could not reach its server. Check that it is running.";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readProvider(value: unknown): VoiceProviderInfo | null {
  const p = record(value);
  const id = str(p?.["id"]);
  if (!p || !id) return null;
  return {
    id,
    label: str(p["label"]) ?? id,
    local: p["local"] === true,
    configured: p["configured"] === true,
    setupHint: str(p["setupHint"]),
    defaultVoice: str(p["defaultVoice"]) ?? "",
    styleModels: strings(p["styleModels"]),
    maxCharacters: typeof p["maxCharacters"] === "number" ? p["maxCharacters"] : 0,
  };
}

function readVoice(value: unknown): VoiceOption | null {
  const v = record(value);
  const id = str(v?.["id"]);
  if (!v || !id) return null;
  return { id, name: str(v["name"]) ?? id, description: str(v["description"]) };
}

async function getJson(path: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await studioApiFetch(path);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

function failure(status: number, body: unknown, what: string): { ok: false; error: string } {
  const error = str(record(body)?.["error"]);
  return { ok: false, error: error ?? `${what} (HTTP ${status}).` };
}

export async function fetchVoiceProviders(): Promise<Loaded<VoiceProviders>> {
  const got = await getJson("/api/voice/providers");
  if (!got) return { ok: false, error: UNREACHABLE };
  const body = record(got.body);
  if (got.status !== 200 || !body) return failure(got.status, got.body, "Voices are unavailable");
  const providers = (Array.isArray(body["providers"]) ? body["providers"] : [])
    .map(readProvider)
    .filter((p): p is VoiceProviderInfo => p !== null);
  return { ok: true, value: { auto: str(body["auto"]) ?? "", providers } };
}

export async function fetchVoices(provider: string): Promise<Loaded<VoiceOption[]>> {
  const got = await getJson(`/api/voice/providers/${encodeURIComponent(provider)}/voices`);
  if (!got) return { ok: false, error: UNREACHABLE };
  const body = record(got.body);
  if (got.status !== 200 || !body) return failure(got.status, got.body, "Voices could not load");
  const voices = (Array.isArray(body["voices"]) ? body["voices"] : [])
    .map(readVoice)
    .filter((v): v is VoiceOption => v !== null);
  return { ok: true, value: voices };
}

/** Speak the draft into the project's assets/voice folder. The server checks every field. */
export async function requestVoice(projectId: string, draft: VoiceDraft): Promise<VoiceOutcome> {
  let res: Response;
  try {
    res = await studioApiFetch(buildProjectApiPath(projectId, "voice"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = record(await res.json().catch(() => null));
  const path = str(body?.["path"]);
  if (res.ok && body && path) {
    return {
      ok: true,
      path,
      provider: str(body["provider"]) ?? draft.provider,
      voice: str(body["voice"]) ?? "",
      durationSeconds: typeof body["durationSeconds"] === "number" ? body["durationSeconds"] : 0,
    };
  }
  return {
    ok: false,
    error: str(body?.["error"]) ?? `The voice could not be generated (HTTP ${res.status}).`,
    code: str(body?.["code"]),
  };
}
