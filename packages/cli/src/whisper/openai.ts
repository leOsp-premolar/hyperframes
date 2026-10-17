/**
 * OpenAI Whisper API transcription engine (`--engine openai`).
 *
 * A cloud alternative to the local whisper.cpp / Parakeet runners for machines
 * that cannot run them, keyed by $OPENAI_API_KEY. The audio is re-encoded to a
 * compact mono MP3 first (the API caps uploads at 25 MB), sent to
 * /v1/audio/transcriptions as verbose_json with word timestamps, and the raw
 * response is written to transcript.json — the same OpenAI shape
 * `loadTranscript` already imports, so the caller normalizes it like any other.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFFmpeg, getFFmpegInstallHint } from "../browser/ffmpeg.js";
import { stoppableExecFile } from "../utils/stoppableExecFile.js";
import { TRANSCRIPT_FILE } from "./transcriptFile.js";
import type { RunnerResult, TranscribeProgress } from "./transcribe.js";

/** The only OpenAI transcription model that returns word-level timestamps. */
export const OPENAI_TRANSCRIBE_MODEL = "whisper-1";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
/** The API rejects larger uploads. */
export const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const ENCODE_TIMEOUT_MS = 10 * 60 * 1000;

export function openaiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env[OPENAI_API_KEY_ENV]?.trim();
  return key ? key : undefined;
}

export function openaiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env["OPENAI_BASE_URL"]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** The fields of a verbose_json response this runner reads. */
interface OpenAIVerboseTranscription {
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

function isVerboseTranscription(value: unknown): value is OpenAIVerboseTranscription {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The API's error message from a non-2xx body, or the raw body when it is not JSON. */
export function openaiErrorMessage(status: number, body: string): string {
  let detail = body.trim().slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed;
      if (typeof error === "object" && error !== null && "message" in error) {
        detail = String(error.message);
      }
    }
  } catch {}
  const hint = status === 401 ? ` Check $${OPENAI_API_KEY_ENV}.` : "";
  return `OpenAI transcription failed (HTTP ${status}): ${detail || "no response body"}.${hint}`;
}

export interface OpenAITranscribeOptions {
  language?: string;
  onProgress?: (message: string) => void;
  onEvent?: (event: TranscribeProgress) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: writes the upload-ready audio and returns its path. */
  encodeAudio?: (inputPath: string, signal?: AbortSignal) => Promise<string>;
}

/** Re-encode any audio/video input to 16 kHz mono 32 kbps MP3: ~14 MB per hour of audio. */
async function encodeForUpload(inputPath: string, signal?: AbortSignal): Promise<string> {
  const ffmpegPath = findFFmpeg();
  if (!ffmpegPath) {
    throw new Error(`ffmpeg is required to prepare audio. Install: ${getFFmpegInstallHint()}`);
  }
  const out = join(tmpdir(), `hyperframes-openai-${process.pid}-${randomUUID()}.mp3`);
  try {
    await stoppableExecFile(
      ffmpegPath,
      [
        "-nostats",
        "-hide_banner",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "32k",
        "-f",
        "mp3",
        "-y",
        out,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: ENCODE_TIMEOUT_MS, signal },
    );
  } catch (err) {
    rmSync(out, { force: true });
    throw err;
  }
  return out;
}

/** The multipart body /v1/audio/transcriptions expects for word-level verbose_json. */
function transcriptionForm(audioPath: string, model: string, language?: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(audioPath)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const base = language?.trim().toLowerCase().split(/[-_]/, 1)[0];
  if (base) form.append("language", base);
  return form;
}

function assertUploadable(audioPath: string): void {
  const size = statSync(audioPath).size;
  if (size <= OPENAI_MAX_UPLOAD_BYTES) return;
  throw new Error(
    `Audio is ${(size / 1024 / 1024).toFixed(1)} MB after compression; the OpenAI API accepts up to 25 MB (about 1h40m of speech). Split the file or use --engine whisper.`,
  );
}

function parseTranscription(body: string): OpenAIVerboseTranscription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("OpenAI transcription returned a response that is not JSON.");
  }
  if (!isVerboseTranscription(parsed) || !Array.isArray(parsed.words)) {
    throw new Error("OpenAI transcription returned no word timestamps.");
  }
  return parsed;
}

async function requestTranscription(
  form: FormData,
  apiKey: string,
  env: NodeJS.ProcessEnv,
  options: OpenAITranscribeOptions,
): Promise<OpenAIVerboseTranscription> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${openaiBaseUrl(env)}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(openaiErrorMessage(res.status, body));
  return parseTranscription(body);
}

/** Word count, duration and onset of a response; duration falls back to the last word's end. */
function summarize(parsed: OpenAIVerboseTranscription) {
  const words = (parsed.words ?? []).filter(
    (w) => typeof w.word === "string" && w.word.trim() && Number.isFinite(w.end),
  );
  const lastEnd = words.reduce((max, w) => Math.max(max, w.end ?? 0), 0);
  const durationSeconds =
    typeof parsed.duration === "number" && parsed.duration > 0 ? parsed.duration : lastEnd;
  return { wordCount: words.length, durationSeconds, speechOnsetSeconds: words[0]?.start ?? null };
}

export async function transcribeWithOpenAI(
  inputPath: string,
  outputDir: string,
  options: OpenAITranscribeOptions = {},
): Promise<RunnerResult> {
  const env = options.env ?? process.env;
  const apiKey = openaiApiKey(env);
  if (!apiKey) {
    throw new Error(
      `$${OPENAI_API_KEY_ENV} is not set. Export your OpenAI API key to use --engine openai.`,
    );
  }
  const model = OPENAI_TRANSCRIBE_MODEL;
  options.onProgress?.("Preparing audio for upload...");
  const audioPath = await (options.encodeAudio ?? encodeForUpload)(inputPath, options.signal);
  try {
    assertUploadable(audioPath);
    const form = transcriptionForm(audioPath, model, options.language);
    options.onProgress?.("Uploading to OpenAI Whisper...");
    options.onEvent?.({ type: "progress", phase: "transcription", model, status: "started" });
    const parsed = await requestTranscription(form, apiKey, env, options);
    const summary = summarize(parsed);
    options.onEvent?.({
      type: "progress",
      phase: "transcription",
      model,
      status: "completed",
      durationSeconds: summary.durationSeconds,
    });

    mkdirSync(outputDir, { recursive: true });
    const transcriptPath = join(outputDir, TRANSCRIPT_FILE);
    writeFileSync(transcriptPath, JSON.stringify(parsed, null, 2));
    return { model, detectedLanguage: parsed.language ?? null, transcriptPath, ...summary };
  } finally {
    if (audioPath !== inputPath) rmSync(audioPath, { force: true });
  }
}
