import { afterEach, describe, expect, it, vi } from "vitest";
import { elevenlabs } from "./elevenlabs.js";
import { kokoro } from "./kokoro.js";
import { STUDIO_VOICES, pitchShift, presetFilters, studio } from "./studioVoices.js";
import type { ProviderContext, ProviderSpeechRequest } from "./types.js";

function ctx(env: Record<string, string | undefined> = {}): ProviderContext {
  return { env, fetch: globalThis.fetch, signal: new AbortController().signal };
}

const speech = { audio: new Uint8Array([1]), appliedSpeed: 1, styleApplied: false };

function request(voice: string): ProviderSpeechRequest {
  return { text: "Hola", voice, model: "studio-v1", speed: 1, style: "tierna", language: "es" };
}

function preset(id: string) {
  const found = STUDIO_VOICES.find((p) => p.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
}

afterEach(() => vi.restoreAllMocks());

describe("the studio voice ladder", () => {
  it("runs from very high to very low, women then men", () => {
    for (const gender of ["female", "male"] as const) {
      const targets = STUDIO_VOICES.filter((p) => p.gender === gender).map((p) => p.targetHz);
      expect(targets).toEqual([...targets].sort((a, b) => b - a));
      expect(targets).toHaveLength(5);
    }
  });

  it("moves each base only a little", () => {
    for (const p of STUDIO_VOICES) {
      expect(p.bases.elevenlabs.maxShift, p.id).toBe(4);
      expect(p.bases.kokoro.maxShift, p.id).toBe(6);
      expect(Math.abs(p.bases.elevenlabs.semitones), p.id).toBeLessThanOrEqual(4);
      expect(Math.abs(p.bases.kokoro.semitones), p.id).toBeLessThanOrEqual(6);
      expect(Math.abs(p.formant - 1), p.id).toBeLessThan(0.061);
    }
  });
});

describe("pitchShift", () => {
  const dalia = preset("dalia");

  it("moves a measured line onto the target", () => {
    expect(pitchShift(dalia, dalia.bases.elevenlabs, 185)).toBeCloseTo(0);
    expect(pitchShift(dalia, dalia.bases.elevenlabs, 185 / 2 ** (2 / 12))).toBeCloseTo(2);
  });

  it("moves no further than the base allows", () => {
    expect(pitchShift(dalia, dalia.bases.elevenlabs, 300)).toBe(-4);
    expect(pitchShift(dalia, dalia.bases.kokoro, 90)).toBe(6);
  });

  it("falls back to the base's own move when the line could not be measured", () => {
    expect(pitchShift(dalia, dalia.bases.elevenlabs, null)).toBe(-0.1);
  });
});

describe("presetFilters", () => {
  it("moves the formants with asetrate and sets the pitch with them held", () => {
    const chain = presetFilters(preset("aurora"), 2.5);
    const pitch = (2 ** (2.5 / 12) / 1.04).toFixed(5);
    expect(chain).toBe(
      `aresample=44100,asetrate=45864,aresample=44100,rubberband=tempo=0.96154:pitch=${pitch}:formant=preserved:pitchq=quality,` +
        "bass=g=-1:f=180:w=0.7,treble=g=1.5:f=3500:w=0.7,alimiter=limit=0.95:level=false",
    );
  });

  it("leaves the formants alone when the preset keeps them", () => {
    expect(presetFilters(preset("clara"), 1.7)).toMatch(
      /^rubberband=tempo=1\.00000:pitch=1\.10318:formant=preserved/,
    );
  });
});

describe("the studio provider", () => {
  it("speaks with the ElevenLabs base when a key is set", async () => {
    const spoken = vi.spyOn(elevenlabs, "synthesize").mockResolvedValue(speech);
    const out = await studio.synthesize(request("elena"), ctx({ ELEVENLABS_API_KEY: "k" }));
    expect(spoken).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: "EXAVITQu4vr4xnSDxMaL",
        model: "eleven_multilingual_v2",
        style: undefined,
      }),
      expect.anything(),
    );
    expect(out.filters).toBe(presetFilters(preset("elena"), -2.1));
  });

  it("falls back to Kokoro's Spanish voice with its own move", async () => {
    vi.spyOn(kokoro, "configured").mockReturnValue(true);
    const spoken = vi.spyOn(kokoro, "synthesize").mockResolvedValue(speech);
    const out = await studio.synthesize(request("joaquin"), ctx());
    expect(spoken).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "em_alex", language: "es" }),
      expect.anything(),
    );
    expect(out.filters).toBe(presetFilters(preset("joaquin"), -6));
  });

  it("names the studio voices when given another", async () => {
    await expect(studio.synthesize(request("rachel"), ctx())).rejects.toMatchObject({
      code: "invalid_option",
      message: expect.stringContaining("aurora, brisa"),
    });
  });

  it("lists the ladder with a Spanish description of each voice", async () => {
    const voices = await studio.listVoices(ctx());
    expect(voices.map((v) => v.id)).toEqual(STUDIO_VOICES.map((p) => p.id));
    expect(voices[0]).toEqual({
      id: "aurora",
      name: "Aurora",
      gender: "female",
      language: "es",
      description: "Mujer · muy aguda · brillante · ~245 Hz",
    });
    expect(voices.at(-1)?.description).toBe("Hombre · muy grave · cálida · ~92 Hz");
  });
});
