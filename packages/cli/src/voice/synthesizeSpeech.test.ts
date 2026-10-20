import { describe, expect, it, vi } from "vitest";
import {
  describeVoiceProvidersWith,
  listVoicesWith,
  pickProvider,
  synthesizeSpeechWith,
  type VoiceDeps,
} from "./synthesizeSpeech.js";
import {
  VoiceError,
  type ProviderSpeech,
  type ProviderSpeechRequest,
  type VoiceEnv,
  type VoiceProvider,
  type VoiceProviderId,
} from "./types.js";

function fakeProvider(
  id: VoiceProviderId,
  overrides: Partial<VoiceProvider> & { speech?: Partial<ProviderSpeech> } = {},
) {
  const requests: ProviderSpeechRequest[] = [];
  const { speech, ...rest } = overrides;
  const provider: VoiceProvider = {
    id,
    label: id,
    local: id === "kokoro",
    models: [`${id}-model`],
    defaultModel: `${id}-model`,
    styleModels: [],
    nativeWords: false,
    maxCharacters: 100,
    setupHint: `set up ${id}`,
    configured: (env) => id === "kokoro" || Boolean(env[`${id.toUpperCase()}_API_KEY`]),
    defaultVoice: (language) => `${id}-voice-${language ?? "default"}`,
    listVoices: async () => [{ id: `${id}-voice`, name: id }],
    synthesize: async (request) => {
      requests.push(request);
      return {
        audio: new Uint8Array([1]),
        appliedSpeed: request.speed,
        styleApplied: false,
        ...speech,
      };
    },
    ...rest,
  };
  return { provider, requests };
}

function deps(env: VoiceEnv = {}, overrides: Partial<VoiceDeps> = {}) {
  const eleven = fakeProvider("elevenlabs");
  const open = fakeProvider("openai");
  const local = fakeProvider("kokoro");
  const presets = fakeProvider("studio", { configured: () => true });
  const writes: { outputPath: string; tempo: number }[] = [];
  const d: VoiceDeps = {
    env,
    fetch: globalThis.fetch,
    providers: {
      elevenlabs: eleven.provider,
      openai: open.provider,
      kokoro: local.provider,
      studio: presets.provider,
    },
    writeSpeech: async (_audio, outputPath, options) => {
      writes.push({ outputPath, tempo: options.tempo });
      return 2;
    },
    transcribeWords: async () => [{ text: "hola", start: 0.1, end: 0.4 }],
    ...overrides,
  };
  return { d, writes, eleven, open, local };
}

const base = { text: "  Hola mundo  ", outputPath: "/tmp/hf-voice-test/line.wav" };

describe("pickProvider", () => {
  it("prefers ElevenLabs, then OpenAI, then Kokoro", () => {
    expect(pickProvider("auto", deps({ ELEVENLABS_API_KEY: "k", OPENAI_API_KEY: "k" }).d).id).toBe(
      "elevenlabs",
    );
    expect(pickProvider("auto", deps({ OPENAI_API_KEY: "k" }).d).id).toBe("openai");
    expect(pickProvider("auto", deps({}).d).id).toBe("kokoro");
  });

  it("refuses an explicit cloud provider without its key", () => {
    expect(() => pickProvider("openai", deps({}).d)).toThrow(
      expect.objectContaining({
        code: "not_configured",
        message: expect.stringContaining("set up openai"),
      }),
    );
  });
});

describe("synthesizeSpeechWith", () => {
  it("speaks with the picked provider's defaults and writes the file", async () => {
    const { d, writes, eleven } = deps({ ELEVENLABS_API_KEY: "k" });
    const result = await synthesizeSpeechWith(d, { ...base, language: "es" });
    expect(eleven.requests).toEqual([
      {
        text: "Hola mundo",
        voice: "elevenlabs-voice-es",
        model: "elevenlabs-model",
        speed: 1,
        style: undefined,
        language: "es",
      },
    ]);
    expect(writes).toEqual([{ outputPath: "/tmp/hf-voice-test/line.wav", tempo: 1 }]);
    expect(result).toEqual({
      provider: "elevenlabs",
      voice: "elevenlabs-voice-es",
      model: "elevenlabs-model",
      outputPath: "/tmp/hf-voice-test/line.wav",
      durationSeconds: 2,
      speed: 1,
      styleApplied: false,
    });
  });

  it("makes up the speed the provider could not, and times words on the slowed audio", async () => {
    const { d, writes } = deps({ ELEVENLABS_API_KEY: "k" });
    d.providers.elevenlabs.synthesize = async () => ({
      audio: new Uint8Array([1]),
      appliedSpeed: 1,
      styleApplied: false,
      words: [{ text: "Hola", start: 0.5, end: 1 }],
    });
    const result = await synthesizeSpeechWith(d, { ...base, speed: 0.5, words: true });
    expect(writes[0]?.tempo).toBe(0.5);
    expect(result.words).toEqual([{ text: "Hola", start: 1, end: 2 }]);
    expect(result.wordsSource).toBe("provider");
  });

  it("transcribes the written file when the provider has no word timings", async () => {
    const transcribeWords = vi.fn(async () => [{ text: "hola", start: 0.1, end: 0.4 }]);
    const { d } = deps({ OPENAI_API_KEY: "k" }, { transcribeWords });
    const result = await synthesizeSpeechWith(d, {
      ...base,
      provider: "openai",
      words: true,
      language: "es",
    });
    expect(transcribeWords).toHaveBeenCalledWith(
      "/tmp/hf-voice-test/line.wav",
      "es",
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({ wordsSource: "transcription", words: [{ text: "hola" }] });
  });

  it("names the written file when its words cannot be timed", async () => {
    const { d } = deps(
      {},
      { transcribeWords: async () => Promise.reject(new Error("no whisper")) },
    );
    const err = await synthesizeSpeechWith(d, { ...base, words: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err).toMatchObject({
      code: "words_failed",
      outputPath: "/tmp/hf-voice-test/line.wav",
      message: expect.stringContaining("no whisper"),
    });
  });

  it("passes the voice, model and style it was given", async () => {
    const { d, open } = deps({ OPENAI_API_KEY: "k" });
    await synthesizeSpeechWith(d, {
      ...base,
      provider: "openai",
      voice: " shimmer ",
      model: "tts-1-hd",
      style: " tierna y amigable ",
      speed: 0.9,
    });
    expect(open.requests[0]).toMatchObject({
      voice: "shimmer",
      model: "tts-1-hd",
      style: "tierna y amigable",
      speed: 0.9,
    });
  });

  it.each([
    [{ text: "   " }, /no text/],
    [{ outputPath: "/tmp/line.ogg" }, /\.wav or \.mp3/],
    [{ speed: 3 }, /speed/],
    [{ speed: "fast" }, /speed/],
    [{ style: "x".repeat(1001) }, /style/],
    [{ language: "spanish!" }, /language/],
    [{ provider: "azure" }, /Unknown provider/],
    [{ timeoutSeconds: 0 }, /timeoutSeconds/],
  ])("rejects %o before calling anyone", async (bad, message) => {
    const { d, eleven, writes } = deps({ ELEVENLABS_API_KEY: "k" });
    // The checks are for callers the types do not reach, such as an HTTP body.
    const options = JSON.parse(JSON.stringify({ ...base, ...bad }));
    await expect(synthesizeSpeechWith(d, options)).rejects.toMatchObject({
      code: "invalid_option",
      message: expect.stringMatching(message),
    });
    expect(eleven.requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("refuses text longer than the provider speaks at once", async () => {
    const { d } = deps({ ELEVENLABS_API_KEY: "k" });
    await expect(synthesizeSpeechWith(d, { ...base, text: "a".repeat(101) })).rejects.toMatchObject(
      {
        code: "text_too_long",
        provider: "elevenlabs",
      },
    );
  });

  it("reports a caller's stop as cancelled", async () => {
    const controller = new AbortController();
    const { d } = deps();
    d.providers.kokoro.synthesize = (_request, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        controller.abort();
      });
    await expect(
      synthesizeSpeechWith(d, { ...base, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports a provider that runs out of time", async () => {
    const { d } = deps();
    d.providers.kokoro.synthesize = (_request, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
      });
    await expect(synthesizeSpeechWith(d, { ...base, timeoutSeconds: 0.05 })).rejects.toMatchObject({
      code: "provider_failed",
      message: expect.stringMatching(/in time/),
    });
  });
});

describe("describeVoiceProvidersWith", () => {
  it("lists every provider, what auto picks, and how to set up the missing ones", () => {
    const summary = describeVoiceProvidersWith(deps({ OPENAI_API_KEY: "secret" }).d);
    expect(summary.auto).toBe("openai");
    expect(summary.providers.map((p) => [p.id, p.configured, p.setupHint])).toEqual([
      ["elevenlabs", false, "set up elevenlabs"],
      ["openai", true, undefined],
      ["kokoro", true, undefined],
      ["studio", true, undefined],
    ]);
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});

describe("listVoicesWith", () => {
  it("lists the chosen provider's voices", async () => {
    const { d } = deps({ OPENAI_API_KEY: "k" });
    await expect(listVoicesWith(d, "openai")).resolves.toEqual([
      { id: "openai-voice", name: "openai" },
    ]);
    await expect(listVoicesWith(d, "auto")).resolves.toEqual([
      { id: "openai-voice", name: "openai" },
    ]);
  });

  it("rejects an unknown provider", async () => {
    await expect(listVoicesWith(deps().d, "azure")).rejects.toMatchObject({
      code: "invalid_option",
    });
  });
});
