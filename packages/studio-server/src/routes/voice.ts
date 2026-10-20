import type { Context, Hono } from "hono";
import { existsSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import type { StudioApiAdapter, StudioVoiceRequest } from "../types.js";
import { requestedProjectPath } from "../helpers/requestSubPath.js";
import { mkdirWithinProject, pinWithinProject } from "../helpers/safePath.js";

const OUTPUT_EXTENSIONS = new Set([".wav", ".mp3"]);
// Generous: each provider enforces its own, lower limit with a message that names it.
const MAX_TEXT_LENGTH = 20_000;
const VOICE_DIR = "assets/voice";

const UNAVAILABLE = { error: "voices are not available in this Studio server" };

/** A file name from the first words, so the asset list says what each line is. */
export function voiceFileBase(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "voice";
}

function freePath(projectDir: string, assetPath: string, taken: ReadonlySet<string>): string {
  const ext = extname(assetPath);
  const stem = assetPath.slice(0, -ext.length);
  let candidate = assetPath;
  for (let n = 2; taken.has(candidate) || existsSync(join(projectDir, candidate)); n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}

type Body = Record<string, unknown>;

function optionalString(body: Body, key: string): string | undefined | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : null;
}

/** The request fields, or the name of the first one with the wrong type. */
// fallow-ignore-next-line complexity
function readRequest(body: Body): StudioVoiceRequest | string {
  const text = body["text"];
  if (typeof text !== "string" || !text.trim()) return "text";
  const fields: Partial<Record<"provider" | "voice" | "model" | "style" | "language", string>> = {};
  for (const key of ["provider", "voice", "model", "style", "language"] as const) {
    const value = optionalString(body, key);
    if (value === null) return key;
    if (value !== undefined) fields[key] = value;
  }
  const speed = body["speed"];
  if (speed !== undefined && speed !== null && typeof speed !== "number") return "speed";
  const words = body["words"];
  if (words !== undefined && typeof words !== "boolean") return "words";
  return {
    text,
    ...fields,
    ...(typeof speed === "number" ? { speed } : {}),
    ...(words ? { words } : {}),
  };
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

const STATUS_BY_CODE: Record<string, 400 | 409 | 502> = {
  invalid_option: 400,
  text_too_long: 400,
  not_configured: 409,
  auth_failed: 502,
  rate_limited: 502,
  provider_failed: 502,
};

/** A voice API failure: its own message and `code`, and a status that says whose fault it was. */
function voiceFailure(c: Context, err: unknown, extra: Record<string, unknown> = {}) {
  const code = errorCode(err) ?? "failed";
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message, code, ...extra }, STATUS_BY_CODE[code] ?? 500);
}

export function registerVoiceRoutes(api: Hono, adapter: StudioApiAdapter): void {
  // Outputs being written right now, so two requests for the same words get two files.
  const writing = new Set<string>();

  api.get("/voice/providers", async (c) => {
    if (!adapter.describeVoiceProviders) return c.json(UNAVAILABLE, 501);
    return c.json(await adapter.describeVoiceProviders());
  });

  api.get("/voice/providers/:provider/voices", async (c) => {
    if (!adapter.listVoices) return c.json(UNAVAILABLE, 501);
    try {
      const voices = await adapter.listVoices(c.req.param("provider"), c.req.raw.signal);
      return c.json({ voices });
    } catch (err) {
      return voiceFailure(c, err);
    }
  });

  // fallow-ignore-next-line complexity
  api.post("/projects/:id/voice", async (c) => {
    if (!adapter.synthesizeVoice) return c.json(UNAVAILABLE, 501);
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);

    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "a JSON object body is required" }, 400);
    }
    const fields = { ...body };
    const request = readRequest(fields);
    if (typeof request === "string") {
      const reason = request === "text" ? "text is required" : `${request} has the wrong type`;
      return c.json({ error: reason, code: "invalid_option" }, 400);
    }
    if (request.text.length > MAX_TEXT_LENGTH) {
      return c.json(
        { error: `text is longer than ${MAX_TEXT_LENGTH} characters`, code: "text_too_long" },
        400,
      );
    }

    const outputField = optionalString(fields, "outputPath");
    if (outputField === null) return c.json({ error: "outputPath has the wrong type" }, 400);
    const requested = outputField
      ? posix.normalize(requestedProjectPath(project.dir, outputField))
      : `${VOICE_DIR}/${voiceFileBase(request.text)}.wav`;
    if (requested.includes("\0")) return c.json({ error: "forbidden" }, 403);
    if (!OUTPUT_EXTENSIONS.has(extname(requested).toLowerCase())) {
      return c.json({ error: "voice output must be .wav or .mp3", code: "invalid_option" }, 400);
    }
    if (!pinWithinProject(project.dir, requested)) return c.json({ error: "forbidden" }, 403);
    const assetPath = freePath(project.dir, requested, writing);
    const outputPath = pinWithinProject(project.dir, assetPath);
    if (!outputPath) return c.json({ error: "forbidden" }, 403);

    writing.add(assetPath);
    try {
      mkdirWithinProject(project.dir, dirname(outputPath));
      const result = await adapter.synthesizeVoice({
        project,
        request,
        outputPath,
        signal: c.req.raw.signal,
      });
      return c.json({ path: assetPath, ...result });
    } catch (err) {
      // Speech that was written before its words failed is in the project; say where.
      const written = errorCode(err) === "words_failed" && existsSync(outputPath);
      return voiceFailure(c, err, written ? { path: assetPath } : {});
    } finally {
      writing.delete(assetPath);
    }
  });
}
