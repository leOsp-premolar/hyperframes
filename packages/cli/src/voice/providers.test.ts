import { describe, expect, it } from "vitest";
import { isCharacterAlignment, wordsFromCharacters } from "./alignment.js";
import { elevenlabs } from "./elevenlabs.js";
import { providerErrorDetail } from "./http.js";
import { kokoro, kokoroLang } from "./kokoro.js";
import { openai } from "./openai.js";
import { VoiceError, type ProviderContext, type VoiceEnv } from "./types.js";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, calls };
}

function context(env: VoiceEnv, fetchFn: typeof fetch, signal = new AbortController().signal) {
  const ctx: ProviderContext = { env, fetch: fetchFn, signal };
  return ctx;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sentBody(call: Call | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(call?.init.body));
  return parsed && typeof parsed === "object" ? { ...parsed } : {};
}

function alignmentFor(text: string, step = 0.1) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * step),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
  };
}

const AUDIO = Buffer.from("ID3-fake-mp3").toString("base64");
const KEY = "sk-test-not-a-real-key";
const request = { text: "Hola, mundo.", voice: "voice-1", model: "eleven_multilingual_v2" };

describe("ElevenLabs", () => {
  it("asks for timed speech and turns the character timings into words", async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({ audio_base64: AUDIO, alignment: alignmentFor("Hola, mundo.") }),
    );
    const speech = await elevenlabs.synthesize(
      { ...request, speed: 1 },
      context({ ELEVENLABS_API_KEY: KEY }, fetchFn),
    );

    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-1/with-timestamps?output_format=mp3_44100_128",
    );
    expect(new Headers(calls[0]?.init.headers).get("xi-api-key")).toBe(KEY);
    expect(sentBody(calls[0])).toEqual({
      text: "Hola, mundo.",
      model_id: "eleven_multilingual_v2",
    });
    expect(Buffer.from(speech.audio).toString()).toBe("ID3-fake-mp3");
    expect(speech.appliedSpeed).toBe(1);
    expect(speech.words?.map((w) => w.text)).toEqual(["Hola,", "mundo."]);
    expect(speech.words?.[1]?.start).toBeCloseTo(0.6);
    expect(speech.words?.[1]?.end).toBeCloseTo(1.2);
  });

  it("sends a speed it supports and leaves the rest to the encoder", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ audio_base64: AUDIO }));
    const ctx = context({ ELEVENLABS_API_KEY: KEY }, fetchFn);

    const gentle = await elevenlabs.synthesize({ ...request, speed: 0.9 }, ctx);
    expect(sentBody(calls[0])["voice_settings"]).toEqual({ speed: 0.9 });
    expect(gentle.appliedSpeed).toBe(0.9);

    const slow = await elevenlabs.synthesize({ ...request, speed: 0.6 }, ctx);
    expect(sentBody(calls[1])["voice_settings"]).toBeUndefined();
    expect(slow.appliedSpeed).toBe(1);
    expect(slow.words).toBeUndefined();
  });

  it("uses ELEVENLABS_BASE_URL and escapes the voice id", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ audio_base64: AUDIO }));
    await elevenlabs.synthesize(
      { ...request, voice: "a/b", speed: 1 },
      context({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_BASE_URL: "http://127.0.0.1:9/" }, fetchFn),
    );
    expect(calls[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:9\/v1\/text-to-speech\/a%2Fb\//);
  });

  it.each([
    [401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }, "auth_failed"],
    [429, { detail: { message: "Too many concurrent requests" } }, "rate_limited"],
    [422, { detail: [{ msg: "text is required" }] }, "provider_failed"],
  ])("turns a %s into %s with the provider's reason", async (status, body, code) => {
    const { fetchFn } = fakeFetch(() => json(body, status));
    const err = await elevenlabs
      .synthesize({ ...request, speed: 1 }, context({ ELEVENLABS_API_KEY: KEY }, fetchFn))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceError);
    if (!(err instanceof VoiceError)) return;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toContain(String(status));
    expect(err.message).not.toContain(KEY);
  });

  it("needs its key", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({}));
    await expect(
      elevenlabs.synthesize({ ...request, speed: 1 }, context({}, fetchFn)),
    ).rejects.toMatchObject({ code: "not_configured", message: /ELEVENLABS_API_KEY/ });
    expect(calls).toHaveLength(0);
  });

  it("reports an answer without audio", async () => {
    const { fetchFn } = fakeFetch(() => json({ alignment: null }));
    await expect(
      elevenlabs.synthesize(
        { ...request, speed: 1 },
        context({ ELEVENLABS_API_KEY: KEY }, fetchFn),
      ),
    ).rejects.toMatchObject({ code: "provider_failed" });
  });

  it("names an unreachable host, and hands an abort back untouched", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(
      elevenlabs.synthesize(
        { ...request, speed: 1 },
        context({ ELEVENLABS_API_KEY: KEY }, down.fetchFn),
      ),
    ).rejects.toMatchObject({ code: "provider_failed", message: /could not be reached/ });

    const controller = new AbortController();
    const reason = new Error("stopped");
    const hung = fakeFetch(() => {
      controller.abort(reason);
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    await expect(
      elevenlabs.synthesize(
        { ...request, speed: 1 },
        context({ ELEVENLABS_API_KEY: KEY }, hung.fetchFn, controller.signal),
      ),
    ).rejects.toBe(reason);
  });

  // A library voice (Rachel, the old default) answers 402 on a free plan; Sarah ships with every
  // account.
  it("defaults to a voice a free account can use", () => {
    expect(elevenlabs.defaultVoice()).toBe("EXAVITQu4vr4xnSDxMaL");
  });

  it("lists the account's voices", async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({
        voices: [
          {
            voice_id: "v1",
            name: "Sofía",
            labels: { gender: "female", accent: "latin american" },
            preview_url: "https://example.test/v1.mp3",
          },
          { name: "no id" },
        ],
      }),
    );
    const voices = await elevenlabs.listVoices(context({ ELEVENLABS_API_KEY: KEY }, fetchFn));
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/voices");
    expect(voices).toEqual([
      {
        id: "v1",
        name: "Sofía",
        gender: "female",
        language: "latin american",
        description: undefined,
        previewUrl: "https://example.test/v1.mp3",
      },
    ]);
  });
});

describe("OpenAI", () => {
  const wav = new Uint8Array([82, 73, 70, 70]);

  it("passes the style as instructions to gpt-4o-mini-tts and keeps speed for the encoder", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(wav));
    const speech = await openai.synthesize(
      { text: "Hola", voice: "coral", model: "gpt-4o-mini-tts", speed: 0.85, style: "tierna" },
      context({ OPENAI_API_KEY: KEY }, fetchFn),
    );
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sentBody(calls[0])).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: "Hola",
      response_format: "wav",
      instructions: "tierna",
    });
    expect([...speech.audio]).toEqual([...wav]);
    expect(speech).toMatchObject({ appliedSpeed: 1, styleApplied: true });
  });

  it("sends speed, not instructions, to tts-1", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(wav));
    const speech = await openai.synthesize(
      { text: "Hola", voice: "nova", model: "tts-1-hd", speed: 1.5, style: "tierna" },
      context({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: "http://127.0.0.1:9/v1/" }, fetchFn),
    );
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/v1/audio/speech");
    expect(sentBody(calls[0])).toMatchObject({ speed: 1.5 });
    expect(sentBody(calls[0])["instructions"]).toBeUndefined();
    expect(speech).toMatchObject({ appliedSpeed: 1.5, styleApplied: false });
  });

  it("reports OpenAI's own error message", async () => {
    const { fetchFn } = fakeFetch(() =>
      json(
        { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
        401,
      ),
    );
    await expect(
      openai.synthesize(
        { text: "Hola", voice: "coral", model: "gpt-4o-mini-tts", speed: 1 },
        context({ OPENAI_API_KEY: KEY }, fetchFn),
      ),
    ).rejects.toMatchObject({
      code: "auth_failed",
      message: "OpenAI answered 401: Incorrect API key provided",
    });
  });

  it("lists its built-in voices without a request", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({}));
    const voices = await openai.listVoices(context({}, fetchFn));
    expect(voices.map((v) => v.id)).toContain(openai.defaultVoice());
    expect(calls).toHaveLength(0);
  });
});

describe("Kokoro", () => {
  it("picks a voice that speaks the text's language", () => {
    expect(kokoro.defaultVoice("es")).toBe("ef_dora");
    expect(kokoro.defaultVoice("pt-BR")).toBe("pf_dora");
    expect(kokoro.defaultVoice("en-gb")).toBe("bf_emma");
    expect(kokoro.defaultVoice("sw")).toBe("af_heart");
    expect(kokoro.defaultVoice()).toBe("af_heart");
  });

  it("phonemizes in the text's language, else the voice's", () => {
    expect(kokoroLang("af_heart", "es")).toBe("es");
    expect(kokoroLang("af_heart", "pt")).toBe("pt-br");
    expect(kokoroLang("bf_emma", "en-gb")).toBe("en-gb");
    expect(kokoroLang("ef_dora", undefined)).toBe("es");
    expect(kokoroLang("ef_dora", "sw")).toBe("es");
  });
});

describe("character alignment", () => {
  it("drops runs of punctuation and keeps punctuation on its word", () => {
    const words = wordsFromCharacters(alignmentFor("Con  la luz — despertó…"));
    expect(words.map((w) => w.text)).toEqual(["Con", "la", "luz", "despertó…"]);
  });

  it("rejects timings that do not line up with the characters", () => {
    expect(isCharacterAlignment(alignmentFor("ab"))).toBe(true);
    expect(
      isCharacterAlignment({
        characters: ["a", "b"],
        character_start_times_seconds: [0],
        character_end_times_seconds: [0.1, 0.2],
      }),
    ).toBe(false);
    expect(isCharacterAlignment(null)).toBe(false);
  });
});

describe("providerErrorDetail", () => {
  it("reads text, nested messages and validation lists, and keeps it short", () => {
    expect(providerErrorDetail("Bad gateway")).toBe("Bad gateway");
    expect(providerErrorDetail(JSON.stringify({ detail: "voice_not_found" }))).toBe(
      "voice_not_found",
    );
    expect(providerErrorDetail(JSON.stringify({ detail: [{ loc: ["body"], msg: "bad" }] }))).toBe(
      "bad",
    );
    expect(providerErrorDetail("x".repeat(1000))).toHaveLength(300);
  });
});
