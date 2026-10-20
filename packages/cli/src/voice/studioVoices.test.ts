import { afterEach, describe, expect, it, vi } from "vitest";
import { elevenlabs } from "./elevenlabs.js";
import { STUDIO_VOICES, studio } from "./studioVoices.js";
import type { ProviderContext, ProviderSpeechRequest } from "./types.js";

function ctx(env: Record<string, string | undefined> = {}): ProviderContext {
  return { env, fetch: globalThis.fetch, signal: new AbortController().signal };
}

const speech = { audio: new Uint8Array([1]), appliedSpeed: 1, styleApplied: false };

function request(voice: string): ProviderSpeechRequest {
  return { text: "Hola", voice, model: "x", speed: 1, style: "tierna", language: "es" };
}

afterEach(() => vi.restoreAllMocks());

describe("the studio voices", () => {
  it("run from high to low, five women then five men", () => {
    for (const gender of ["female", "male"] as const) {
      const pitches = STUDIO_VOICES.filter((p) => p.gender === gender).map((p) => p.measuredHz);
      expect(pitches).toHaveLength(5);
      expect(pitches).toEqual([...pitches].sort((a, b) => b - a));
    }
  });

  it("are ten different account voices", () => {
    expect(new Set(STUDIO_VOICES.map((p) => p.voice)).size).toBe(10);
  });
});

describe("the studio provider", () => {
  it("speaks with the voice's ElevenLabs voice and delivery, and nothing else", async () => {
    const spoken = vi.spyOn(elevenlabs, "synthesize").mockResolvedValue(speech);
    const out = await studio.synthesize(request("joaquin"), ctx({ ELEVENLABS_API_KEY: "k" }));
    expect(spoken).toHaveBeenCalledWith(
      {
        text: "Hola",
        voice: "nPczCjzI2devNBz1zQrb",
        model: "eleven_multilingual_v2",
        speed: 1,
        style: undefined,
        language: "es",
        tuning: { stability: 0.55, similarity: 0.75, style: 0.1, speakerBoost: true },
      },
      expect.anything(),
    );
    expect(out).toBe(speech);
  });

  it("is set up exactly when ElevenLabs is", () => {
    expect(studio.configured({ ELEVENLABS_API_KEY: "k" })).toBe(true);
    expect(studio.configured({})).toBe(false);
  });

  it("names the studio voices when given another", async () => {
    await expect(studio.synthesize(request("rachel"), ctx())).rejects.toMatchObject({
      code: "invalid_option",
      message: expect.stringContaining("aurora, brisa"),
    });
  });

  it("lists the voices with a Spanish description of each", async () => {
    const voices = await studio.listVoices(ctx());
    expect(voices.map((v) => v.id)).toEqual(STUDIO_VOICES.map((p) => p.id));
    expect(voices[0]).toEqual({
      id: "aurora",
      name: "Aurora",
      gender: "female",
      language: "es",
      description: "Mujer · aguda · luminosa y cálida · ~212 Hz",
    });
    expect(voices.at(-1)?.description).toBe("Hombre · grave · profundo y reconfortante · ~105 Hz");
  });
});
