import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { elevenlabs } from "./elevenlabs.js";
import { kokoro } from "./kokoro.js";
import { measurePitch } from "./pitch.js";
import {
  VoiceError,
  type ProviderContext,
  type ProviderSpeech,
  type VoiceProvider,
  type VoiceSummary,
} from "./types.js";

interface Base {
  voice: string;
  /** The move to the target from the base's measured pitch; used when a line cannot be measured. */
  semitones: number;
  /** The most a line may be moved toward the target, so the voice stays natural. */
  maxShift: number;
}

export interface StudioVoicePreset {
  id: string;
  name: string;
  gender: "female" | "male";
  register: string;
  /** Median pitch the preset lands on in Spanish speech, as the engine's pitch tracker reads it. */
  targetHz: number;
  /** Formant ratio, the timbre: above 1 younger and brighter, below 1 bigger and darker. */
  formant: number;
  bassDb: number;
  trebleDb: number;
  /** ElevenLabs when a key is set, else Kokoro on this machine. */
  bases: { elevenlabs: Base; kokoro: Base };
}

const ELEVENLABS_SHIFT = 4;
const KOKORO_SHIFT = 6;
const SARAH = "EXAVITQu4vr4xnSDxMaL";

const el = (voice: string, semitones: number): Base => ({
  voice,
  semitones,
  maxShift: ELEVENLABS_SHIFT,
});
const ko = (voice: string, semitones: number): Base => ({
  voice,
  semitones,
  maxShift: KOKORO_SHIFT,
});

// A ladder from very high to very low, women then men. Each ElevenLabs base is an account voice
// whose Spanish median pitch sits near the target; the measurements are in
// plans/studio-editor-roadmap.md (S9). ElevenLabs reads each line a little differently, so every
// line is measured and moved to the target, at most 4 semitones. Kokoro has one Spanish voice
// per gender and may move 6; its extremes fall a little short.
export const STUDIO_VOICES: readonly StudioVoicePreset[] = [
  {
    id: "aurora",
    name: "Aurora",
    gender: "female",
    register: "very high",
    targetHz: 245,
    formant: 1.04,
    bassDb: -1,
    trebleDb: 1.5,
    bases: { elevenlabs: el("hpp4J3VqNfWAUOO0d1Us", 2.3), kokoro: ko("ef_dora", 5.3) },
  },
  {
    id: "brisa",
    name: "Brisa",
    gender: "female",
    register: "high",
    targetHz: 225,
    formant: 1.02,
    bassDb: 0,
    trebleDb: 1,
    bases: { elevenlabs: el("XrExE9yKIg1WjnnlVkGX", 0.7), kokoro: ko("ef_dora", 3.8) },
  },
  {
    id: "clara",
    name: "Clara",
    gender: "female",
    register: "mid-high",
    targetHz: 205,
    formant: 1,
    bassDb: 0,
    trebleDb: 0.5,
    bases: { elevenlabs: el("cgSgspJ2msm6clMCkdW9", 1.6), kokoro: ko("ef_dora", 2.2) },
  },
  {
    id: "dalia",
    name: "Dalia",
    gender: "female",
    register: "mid",
    targetHz: 185,
    formant: 0.99,
    bassDb: 1,
    trebleDb: 0,
    bases: { elevenlabs: el(SARAH, -0.1), kokoro: ko("ef_dora", 0.4) },
  },
  {
    id: "elena",
    name: "Elena",
    gender: "female",
    register: "low",
    targetHz: 165,
    formant: 0.96,
    bassDb: 2,
    trebleDb: -0.5,
    bases: { elevenlabs: el(SARAH, -2.1), kokoro: ko("ef_dora", -1.6) },
  },
  {
    id: "fabian",
    name: "Fabián",
    gender: "male",
    register: "high",
    targetHz: 150,
    formant: 1,
    bassDb: 0,
    trebleDb: 0.5,
    bases: { elevenlabs: el("cjVigY5qzO86Huf0OWal", -2), kokoro: ko("em_alex", 0.7) },
  },
  {
    id: "gael",
    name: "Gael",
    gender: "male",
    register: "mid-high",
    targetHz: 135,
    formant: 1.02,
    bassDb: 0,
    trebleDb: 0.5,
    bases: { elevenlabs: el("CwhRBWXzGAHq8TQ4Fs17", -0.6), kokoro: ko("em_alex", -1.1) },
  },
  {
    id: "hugo",
    name: "Hugo",
    gender: "male",
    register: "mid",
    targetHz: 120,
    formant: 1,
    bassDb: 0.5,
    trebleDb: 0,
    bases: { elevenlabs: el("bIHbv24MWmeRgasZH58o", -1.3), kokoro: ko("em_alex", -3.1) },
  },
  {
    id: "iker",
    name: "Íker",
    gender: "male",
    register: "low",
    targetHz: 105,
    formant: 0.97,
    bassDb: 1.5,
    trebleDb: -0.5,
    bases: { elevenlabs: el("JBFqnCBsd6RMkjVDRZzb", -4), kokoro: ko("em_alex", -5.4) },
  },
  {
    id: "joaquin",
    name: "Joaquín",
    gender: "male",
    register: "very low",
    targetHz: 92,
    formant: 0.94,
    bassDb: 2.5,
    trebleDb: -1,
    bases: { elevenlabs: el("nPczCjzI2devNBz1zQrb", -4), kokoro: ko("em_alex", -6) },
  },
];

/**
 * The ffmpeg filters that turn a base voice into the preset. Playing faster (asetrate) moves
 * pitch and formants together; rubberband then restores the length and sets the pitch with the
 * formants held, so the two move independently and words keep their timings.
 */
export function presetFilters(p: StudioVoicePreset, semitones: number): string {
  const ratio = 2 ** (semitones / 12);
  const parts: string[] = [];
  if (Math.abs(p.formant - 1) > 1e-4) {
    // asetrate's rate is absolute, so the audio must be at 44.1 kHz first: Kokoro and OpenAI
    // send 24 kHz, which would otherwise play almost twice as fast.
    parts.push("aresample=44100", `asetrate=${Math.round(44100 * p.formant)}`, "aresample=44100");
  }
  const tempo = (1 / p.formant).toFixed(5);
  const pitch = (ratio / p.formant).toFixed(5);
  parts.push(`rubberband=tempo=${tempo}:pitch=${pitch}:formant=preserved:pitchq=quality`);
  if (p.bassDb) parts.push(`bass=g=${p.bassDb}:f=180:w=0.7`);
  if (p.trebleDb) parts.push(`treble=g=${p.trebleDb}:f=3500:w=0.7`);
  parts.push("alimiter=limit=0.95:level=false");
  return parts.join(",");
}

/** The move that puts a line measured at `measuredHz` on the preset's target, within the base's limit. */
export function pitchShift(p: StudioVoicePreset, base: Base, measuredHz: number | null): number {
  if (!measuredHz || !Number.isFinite(measuredHz)) return base.semitones;
  const needed = 12 * Math.log2(p.targetHz / measuredHz);
  return Math.max(-base.maxShift, Math.min(base.maxShift, needed));
}

/** The base line's median pitch, or null when it cannot be measured (no ffmpeg, no voice). */
async function measureLine(audio: Uint8Array, ctx: ProviderContext): Promise<number | null> {
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) return null;
  const dir = mkdtempSync(join(tmpdir(), "hf-voice-pitch-"));
  try {
    const file = join(dir, "line");
    writeFileSync(file, audio);
    return await measurePitch(ffmpeg, file, ctx.signal);
  } catch {
    // An unmeasurable line keeps the base's fixed move; only a stop is the caller's business.
    if (ctx.signal.aborted) throw ctx.signal.reason;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REGISTER_ES: Record<string, string> = {
  "very high": "muy aguda",
  high: "aguda",
  "mid-high": "media-aguda",
  mid: "media",
  low: "grave",
  "very low": "muy grave",
};

function describe(p: StudioVoicePreset): string {
  const who = p.gender === "female" ? "Mujer" : "Hombre";
  const register = REGISTER_ES[p.register] ?? p.register;
  const tone = p.formant > 1 ? "brillante" : p.formant < 1 ? "cálida" : "natural";
  return `${who} · ${register} · ${tone} · ~${p.targetHz} Hz`;
}

export const studio: VoiceProvider = {
  id: "studio",
  label: "Studio voices",
  local: false,
  models: ["studio-v1"],
  defaultModel: "studio-v1",
  styleModels: [],
  nativeWords: false,
  maxCharacters: kokoro.maxCharacters,
  setupHint: `${elevenlabs.setupHint} Without it they run on Kokoro: ${kokoro.setupHint}`,

  configured(env) {
    return elevenlabs.configured(env) || kokoro.configured(env);
  },

  defaultVoice() {
    return "dalia";
  },

  async listVoices(): Promise<VoiceSummary[]> {
    return STUDIO_VOICES.map((p) => ({
      id: p.id,
      name: p.name,
      gender: p.gender,
      language: "es",
      description: describe(p),
    }));
  },

  async synthesize(request, ctx): Promise<ProviderSpeech> {
    const p = STUDIO_VOICES.find((v) => v.id === request.voice);
    if (!p) {
      const ids = STUDIO_VOICES.map((v) => v.id).join(", ");
      throw new VoiceError(
        "invalid_option",
        `Unknown studio voice '${request.voice}'. Use: ${ids}.`,
        { provider: "studio" },
      );
    }
    const onElevenLabs = elevenlabs.configured(ctx.env);
    const engine = onElevenLabs ? elevenlabs : kokoro;
    const base = onElevenLabs ? p.bases.elevenlabs : p.bases.kokoro;
    const speech = await engine.synthesize(
      { ...request, voice: base.voice, model: engine.defaultModel, style: undefined },
      ctx,
    );
    const measured = await measureLine(speech.audio, ctx);
    return { ...speech, filters: presetFilters(p, pitchShift(p, base, measured)) };
  },
};
