// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StudioApiAdapter, StudioVoiceRequest } from "../types";
import { registerVoiceRoutes, voiceFileBase } from "./voice";
import { stubAdapter } from "./stubAdapter.test-helpers";

interface Spoken {
  request: StudioVoiceRequest;
  outputPath: string;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

let project: string;
let spoken: Spoken[];

function app(overrides: Partial<StudioApiAdapter> = {}) {
  const adapter: StudioApiAdapter = {
    ...stubAdapter(project),
    describeVoiceProviders: () => ({
      auto: "elevenlabs",
      providers: [
        {
          id: "elevenlabs",
          label: "ElevenLabs",
          local: false,
          configured: true,
          defaultVoice: "v1",
          defaultModel: "eleven_multilingual_v2",
          models: ["eleven_multilingual_v2"],
          styleModels: [],
          nativeWords: true,
          maxCharacters: 10000,
        },
      ],
    }),
    listVoices: async (provider) => [{ id: `${provider}-v1`, name: "Sofía" }],
    synthesizeVoice: async ({ request, outputPath }) => {
      spoken.push({ request, outputPath });
      writeFileSync(outputPath, "RIFF");
      return {
        provider: "elevenlabs",
        voice: "v1",
        model: "eleven_multilingual_v2",
        durationSeconds: 2.4,
        speed: request.speed ?? 1,
        styleApplied: false,
      };
    },
    ...overrides,
  };
  const api = new Hono();
  registerVoiceRoutes(api, adapter);
  return api;
}

function post(api: Hono, body: unknown) {
  return api.request("/projects/demo/voice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "hf-voice-route-"));
  spoken = [];
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("voiceFileBase", () => {
  it("names the file after the first words, without accents", () => {
    expect(voiceFileBase("Con la primera luz de la mañana, una semilla")).toBe(
      "con-la-primera-luz-de-la",
    );
    expect(voiceFileBase("¡Ñandú!")).toBe("nandu");
    expect(voiceFileBase("… —")).toBe("voice");
  });
});

describe("POST /projects/:id/voice", () => {
  it("speaks into assets/voice and answers with the asset path", async () => {
    const res = await post(app(), { text: "Con la primera luz", provider: "auto", speed: 0.9 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      path: "assets/voice/con-la-primera-luz.wav",
      provider: "elevenlabs",
      durationSeconds: 2.4,
      speed: 0.9,
    });
    expect(spoken[0]?.request).toEqual({
      text: "Con la primera luz",
      provider: "auto",
      speed: 0.9,
    });
    expect(spoken[0]?.outputPath).toBe(join(project, "assets/voice/con-la-primera-luz.wav"));
    expect(existsSync(join(project, "assets/voice/con-la-primera-luz.wav"))).toBe(true);
  });

  it("never replaces a file that is already there", async () => {
    mkdirSync(join(project, "assets/voice"), { recursive: true });
    writeFileSync(join(project, "assets/voice/hola.wav"), "old");
    const res = await post(app(), { text: "Hola" });
    expect((await res.json()).path).toBe("assets/voice/hola-2.wav");
  });

  it("gives two requests in flight for the same words two files", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = app({
      synthesizeVoice: async ({ outputPath }) => {
        await gate;
        writeFileSync(outputPath, "RIFF");
        return {
          provider: "kokoro",
          voice: "af_heart",
          model: "kokoro-v1.0",
          durationSeconds: 1,
          speed: 1,
          styleApplied: false,
        };
      },
    });
    const first = post(api, { text: "Hola" });
    const second = post(api, { text: "Hola" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const paths = await Promise.all(
      [first, second].map(async (r) => (await (await r).json()).path),
    );
    expect(new Set(paths)).toEqual(new Set(["assets/voice/hola.wav", "assets/voice/hola-2.wav"]));
  });

  it("writes to a project path it is given, as .wav or .mp3 only", async () => {
    const res = await post(app(), { text: "Hola", outputPath: "audio/intro.mp3" });
    expect((await res.json()).path).toBe("audio/intro.mp3");
    expect((await post(app(), { text: "Hola", outputPath: "audio/intro.ogg" })).status).toBe(400);
  });

  it.each([["../outside.wav"], ["/etc/voice.wav"], [".hyperframes/voice.wav"]])(
    "refuses an output outside the project's own files: %s",
    async (outputPath) => {
      const res = await post(app(), { text: "Hola", outputPath });
      expect(res.status).toBe(403);
      expect(spoken).toHaveLength(0);
    },
  );

  it.each([
    [{}, "text is required"],
    [{ text: "   " }, "text is required"],
    [{ text: "Hola", speed: "fast" }, "speed has the wrong type"],
    [{ text: "Hola", provider: 3 }, "provider has the wrong type"],
    [{ text: "Hola", words: "yes" }, "words has the wrong type"],
    [{ text: "x".repeat(20_001) }, "longer than"],
  ])("rejects %o", async (body, message) => {
    const res = await post(app(), body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(spoken).toHaveLength(0);
  });

  it("rejects a body that is not a JSON object", async () => {
    expect((await post(app(), "[1]")).status).toBe(400);
    expect((await post(app(), "not json")).status).toBe(400);
  });

  it.each([
    ["not_configured", 409],
    ["invalid_option", 400],
    ["auth_failed", 502],
    ["rate_limited", 502],
    ["provider_failed", 502],
    ["encode_failed", 500],
  ])("answers a %s failure with %s and its message", async (code, status) => {
    const api = app({
      synthesizeVoice: async () => Promise.reject(codedError(code, `failed: ${code}`)),
    });
    const res = await post(api, { text: "Hola" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `failed: ${code}`, code });
  });

  it("says where the speech is when only its words failed", async () => {
    const api = app({
      synthesizeVoice: async ({ outputPath }) => {
        writeFileSync(outputPath, "RIFF");
        throw codedError("words_failed", "no whisper");
      },
    });
    const res = await post(api, { text: "Hola", words: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "words_failed", path: "assets/voice/hola.wav" });
  });

  it("answers 501 when the server has no voice engine, and 404 for an unknown project", async () => {
    expect((await post(app({ synthesizeVoice: undefined }), { text: "Hola" })).status).toBe(501);
    const api = app({ resolveProject: async () => null });
    expect((await post(api, { text: "Hola" })).status).toBe(404);
  });
});

describe("voice listings", () => {
  it("describes the providers", async () => {
    const res = await app().request("/voice/providers");
    expect(res.status).toBe(200);
    expect((await res.json()).auto).toBe("elevenlabs");
    expect(
      (await app({ describeVoiceProviders: undefined }).request("/voice/providers")).status,
    ).toBe(501);
  });

  it("lists a provider's voices and passes its failures on", async () => {
    const res = await app().request("/voice/providers/openai/voices");
    expect(await res.json()).toEqual({ voices: [{ id: "openai-v1", name: "Sofía" }] });

    const failing = app({
      listVoices: async () =>
        Promise.reject(codedError("not_configured", "Set ELEVENLABS_API_KEY")),
    });
    const refused = await failing.request("/voice/providers/elevenlabs/voices");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Set ELEVENLABS_API_KEY",
      code: "not_configured",
    });
  });
});
