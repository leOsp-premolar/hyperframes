import { elevenlabs } from "./elevenlabs.js";
import {
  VoiceError,
  type ProviderSpeech,
  type VoiceProvider,
  type VoiceSummary,
  type VoiceTuning,
} from "./types.js";

export interface StudioVoicePreset {
  id: string;
  name: string;
  gender: "female" | "male";
  register: string;
  /** Median pitch measured in Spanish, which orders the voices; the audio is never altered. */
  measuredHz: number;
  /** One of the voices every ElevenLabs account has. */
  voice: string;
  /** How it performs: steadier or more expressive. */
  tuning: VoiceTuning;
  /** A few words on its manner, in Spanish, for the voice list. */
  character: string;
}

const tune = (stability: number, style: number): VoiceTuning => ({
  stability,
  similarity: 0.75,
  style,
  speakerBoost: true,
});

// Ten account voices from high to low, women then men, measured speaking the same Spanish line
// (plans/studio-editor-roadmap.md, S9). They are used as recorded: moving pitch or formants after
// the fact made them sound robotic, so they differ only in voice and delivery.
export const STUDIO_VOICES: readonly StudioVoicePreset[] = [
  {
    id: "aurora",
    name: "Aurora",
    gender: "female",
    register: "high",
    measuredHz: 212,
    voice: "hpp4J3VqNfWAUOO0d1Us",
    tuning: tune(0.45, 0.25),
    character: "luminosa y cálida",
  },
  {
    id: "brisa",
    name: "Brisa",
    gender: "female",
    register: "high",
    measuredHz: 210,
    voice: "XrExE9yKIg1WjnnlVkGX",
    tuning: tune(0.5, 0.2),
    character: "clara y animada",
  },
  {
    id: "clara",
    name: "Clara",
    gender: "female",
    register: "mid",
    measuredHz: 187,
    voice: "EXAVITQu4vr4xnSDxMaL",
    tuning: tune(0.55, 0.1),
    character: "serena y confiable",
  },
  {
    id: "dalia",
    name: "Dalia",
    gender: "female",
    register: "mid",
    measuredHz: 186,
    voice: "cgSgspJ2msm6clMCkdW9",
    tuning: tune(0.4, 0.3),
    character: "juvenil y alegre",
  },
  {
    id: "elena",
    name: "Elena",
    gender: "female",
    register: "low",
    measuredHz: 159,
    voice: "pFZP5JQG7iQjIQuC4Bku",
    tuning: tune(0.6, 0.1),
    character: "aterciopelada y pausada",
  },
  {
    id: "fabian",
    name: "Fabián",
    gender: "male",
    register: "high",
    measuredHz: 163,
    voice: "cjVigY5qzO86Huf0OWal",
    tuning: tune(0.5, 0.15),
    character: "suave y cercano",
  },
  {
    id: "gael",
    name: "Gael",
    gender: "male",
    register: "mid",
    measuredHz: 140,
    voice: "onwK4e9ZLuTAKqWW03F9",
    tuning: tune(0.6, 0.05),
    character: "firme, de locutor",
  },
  {
    id: "hugo",
    name: "Hugo",
    gender: "male",
    register: "mid",
    measuredHz: 124,
    voice: "JBFqnCBsd6RMkjVDRZzb",
    tuning: tune(0.5, 0.2),
    character: "cálido, de narrador",
  },
  {
    id: "iker",
    name: "Íker",
    gender: "male",
    register: "low",
    measuredHz: 116,
    voice: "bIHbv24MWmeRgasZH58o",
    tuning: tune(0.45, 0.2),
    character: "relajado y optimista",
  },
  {
    id: "joaquin",
    name: "Joaquín",
    gender: "male",
    register: "low",
    measuredHz: 105,
    voice: "nPczCjzI2devNBz1zQrb",
    tuning: tune(0.55, 0.1),
    character: "profundo y reconfortante",
  },
];

const REGISTER_ES: Record<string, string> = { high: "aguda", mid: "media", low: "grave" };

function describe(p: StudioVoicePreset): string {
  const who = p.gender === "female" ? "Mujer" : "Hombre";
  const register = REGISTER_ES[p.register] ?? p.register;
  return `${who} · ${register} · ${p.character} · ~${p.measuredHz} Hz`;
}

export const studio: VoiceProvider = {
  id: "studio",
  label: "Studio voices",
  local: false,
  models: [elevenlabs.defaultModel],
  defaultModel: elevenlabs.defaultModel,
  styleModels: [],
  nativeWords: true,
  maxCharacters: elevenlabs.maxCharacters,
  setupHint: `Studio voices are ElevenLabs voices. ${elevenlabs.setupHint}`,

  configured(env) {
    return elevenlabs.configured(env);
  },

  defaultVoice() {
    // Sarah, the engine's ElevenLabs default too.
    return "clara";
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
    return elevenlabs.synthesize(
      {
        ...request,
        voice: p.voice,
        model: elevenlabs.defaultModel,
        style: undefined,
        tuning: p.tuning,
      },
      ctx,
    );
  },
};
