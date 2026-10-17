import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTranscript } from "./normalize.js";
import {
  OPENAI_MAX_UPLOAD_BYTES,
  OPENAI_TRANSCRIBE_MODEL,
  openaiBaseUrl,
  openaiErrorMessage,
  transcribeWithOpenAI,
} from "./openai.js";
import type { TranscribeProgress } from "./transcribe.js";

const RESPONSE = {
  task: "transcribe",
  language: "spanish",
  duration: 2.5,
  text: "Hola mundo",
  words: [
    { word: "Hola", start: 0.32, end: 0.71 },
    { word: "mundo", start: 0.8, end: 1.25 },
  ],
};

let dir: string;
let encoded: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hf-openai-test-"));
  encoded = join(dir, "upload.mp3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeEncode(bytes = 1024) {
  return async () => {
    writeFileSync(encoded, Buffer.alloc(bytes));
    return encoded;
  };
}

interface Captured {
  url?: string;
  init?: RequestInit;
}

function fakeFetch(status: number, body: string, captured: Captured = {}): typeof fetch {
  return async (url, init) => {
    captured.url = String(url);
    captured.init = init;
    return new Response(body, { status });
  };
}

describe("transcribeWithOpenAI", () => {
  it("uploads verbose_json with word timestamps and writes a transcript loadTranscript reads", async () => {
    const captured: Captured = {};
    const events: TranscribeProgress[] = [];
    const result = await transcribeWithOpenAI(join(dir, "in.mp4"), dir, {
      language: "es-MX",
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(200, JSON.stringify(RESPONSE), captured),
      encodeAudio: fakeEncode(),
      onEvent: (e) => events.push(e),
    });

    expect(captured.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(new Headers(captured.init?.headers).get("authorization")).toBe("Bearer sk-test");
    const form = captured.init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) return;
    expect(form.get("model")).toBe(OPENAI_TRANSCRIBE_MODEL);
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toContain("word");
    expect(form.get("language")).toBe("es");

    expect(result).toMatchObject({
      model: "whisper-1",
      detectedLanguage: "spanish",
      wordCount: 2,
      durationSeconds: 2.5,
      speechOnsetSeconds: 0.32,
    });
    expect(
      events.map((e) => (e.type === "progress" && e.phase === "transcription" ? e.status : e.type)),
    ).toEqual(["started", "completed"]);
    const { words, format } = loadTranscript(result.transcriptPath);
    expect(format).toBe("openai");
    expect(words).toEqual([
      { id: "w0", text: "Hola", start: 0.32, end: 0.71 },
      { id: "w1", text: "mundo", start: 0.8, end: 1.25 },
    ]);
    // The temporary upload file is cleaned up.
    expect(existsSync(encoded)).toBe(false);
  });

  it("honors OPENAI_BASE_URL", async () => {
    const captured: Captured = {};
    await transcribeWithOpenAI(join(dir, "in.wav"), dir, {
      env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://proxy.example/v1/" },
      fetchImpl: fakeFetch(200, JSON.stringify(RESPONSE), captured),
      encodeAudio: fakeEncode(),
    });
    expect(captured.url).toBe("https://proxy.example/v1/audio/transcriptions");
    expect(openaiBaseUrl({})).toBe("https://api.openai.com/v1");
  });

  it("fails without an API key before encoding anything", async () => {
    let encodedCalled = false;
    await expect(
      transcribeWithOpenAI(join(dir, "in.wav"), dir, {
        env: {},
        encodeAudio: async () => {
          encodedCalled = true;
          return encoded;
        },
      }),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/);
    expect(encodedCalled).toBe(false);
  });

  it("surfaces the API error message and leaves no transcript", async () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided" } });
    await expect(
      transcribeWithOpenAI(join(dir, "in.wav"), dir, {
        env: { OPENAI_API_KEY: "sk-bad" },
        fetchImpl: fakeFetch(401, body),
        encodeAudio: fakeEncode(),
      }),
    ).rejects.toThrow(/HTTP 401\): Incorrect API key provided\. Check \$OPENAI_API_KEY/);
    expect(existsSync(join(dir, "transcript.json"))).toBe(false);
    expect(existsSync(encoded)).toBe(false);
  });

  it("rejects audio over the upload limit without calling the API", async () => {
    let called = false;
    await expect(
      transcribeWithOpenAI(join(dir, "in.wav"), dir, {
        env: { OPENAI_API_KEY: "sk-test" },
        fetchImpl: async () => {
          called = true;
          return new Response("{}");
        },
        encodeAudio: fakeEncode(OPENAI_MAX_UPLOAD_BYTES + 1),
      }),
    ).rejects.toThrow(/accepts up to 25 MB/);
    expect(called).toBe(false);
  });

  it("rejects a response without word timestamps", async () => {
    await expect(
      transcribeWithOpenAI(join(dir, "in.wav"), dir, {
        env: { OPENAI_API_KEY: "sk-test" },
        fetchImpl: fakeFetch(200, JSON.stringify({ text: "hola" })),
        encodeAudio: fakeEncode(),
      }),
    ).rejects.toThrow(/no word timestamps/);
  });

  it("encodes real audio with ffmpeg before upload", async () => {
    const wav = join(dir, "tone.wav");
    const { spawnSync } = await import("node:child_process");
    const ff = spawnSync("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-y",
      wav,
    ]);
    if (ff.status !== 0) return; // no ffmpeg on this machine
    const uploads: Blob[] = [];
    await transcribeWithOpenAI(wav, dir, {
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async (_url, init) => {
        const file = init?.body instanceof FormData ? init.body.get("file") : null;
        if (file instanceof Blob) uploads.push(file);
        return new Response(JSON.stringify(RESPONSE));
      },
    });
    expect(uploads).toHaveLength(1);
    const bytes = Buffer.from(await uploads[0]!.arrayBuffer());
    // An MP3 starts with an ID3 tag or a frame sync.
    expect(bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 0xff).toBe(true);
    expect(readFileSync(wav).length).toBeGreaterThan(bytes.length);
  });
});

describe("openaiErrorMessage", () => {
  it("falls back to the raw body when it is not JSON", () => {
    expect(openaiErrorMessage(502, "Bad gateway")).toBe(
      "OpenAI transcription failed (HTTP 502): Bad gateway.",
    );
  });
});
