import { isCharacterAlignment, wordsFromCharacters } from "./alignment.js";
import { baseUrl, providerFetch, requireKey } from "./http.js";
import {
  VoiceError,
  type ProviderContext,
  type ProviderSpeech,
  type ProviderSpeechRequest,
  type VoiceProvider,
  type VoiceSummary,
} from "./types.js";

const LABEL = "ElevenLabs";
const KEY = "ELEVENLABS_API_KEY";
const DEFAULT_BASE = "https://api.elevenlabs.io";
// Sarah, one of the voices every account gets. Rachel, the media-use skill's default, is a
// library voice: the API answers 402 for it on a free plan.
const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";
// voice_settings.speed accepts this range; slower or faster is done with atempo.
const NATIVE_SPEED: readonly [number, number] = [0.7, 1.2];

function apiBase(ctx: ProviderContext): string {
  return baseUrl(ctx.env["ELEVENLABS_BASE_URL"], DEFAULT_BASE);
}

function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value) {
    throw new VoiceError("provider_failed", `${LABEL} answered without audio.`, {
      provider: "elevenlabs",
    });
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

interface ElevenLabsVoice {
  voice_id?: unknown;
  name?: unknown;
  description?: unknown;
  preview_url?: unknown;
  labels?: Record<string, unknown> | null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toSummary(voice: ElevenLabsVoice): VoiceSummary | null {
  const id = text(voice.voice_id);
  if (!id) return null;
  const labels = voice.labels ?? {};
  return {
    id,
    name: text(voice.name) ?? id,
    gender: text(labels["gender"]),
    language: text(labels["language"]) ?? text(labels["accent"]),
    description: text(voice.description) ?? text(labels["description"]),
    previewUrl: text(voice.preview_url),
  };
}

export const elevenlabs: VoiceProvider = {
  id: "elevenlabs",
  label: LABEL,
  local: false,
  models: ["eleven_multilingual_v2", "eleven_v3", "eleven_turbo_v2_5", "eleven_flash_v2_5"],
  defaultModel: "eleven_multilingual_v2",
  // Its models take audio tags in the text itself, not separate delivery instructions.
  styleModels: [],
  nativeWords: true,
  maxCharacters: 10_000,
  setupHint: `Set ${KEY} (elevenlabs.io → Profile → API keys).`,

  configured(env) {
    return Boolean(env[KEY]?.trim());
  },

  defaultVoice() {
    return DEFAULT_VOICE;
  },

  async listVoices(ctx) {
    const key = requireKey("elevenlabs", LABEL, KEY, ctx);
    const response = await providerFetch(
      "elevenlabs",
      LABEL,
      `${apiBase(ctx)}/v1/voices`,
      { headers: { "xi-api-key": key, accept: "application/json" } },
      ctx,
    );
    const body = (await response.json()) as { voices?: ElevenLabsVoice[] };
    return (body.voices ?? []).map(toSummary).filter((v): v is VoiceSummary => v !== null);
  },

  async synthesize(request: ProviderSpeechRequest, ctx): Promise<ProviderSpeech> {
    const key = requireKey("elevenlabs", LABEL, KEY, ctx);
    const [low, high] = NATIVE_SPEED;
    const speed = request.speed >= low && request.speed <= high ? request.speed : 1;
    const url =
      `${apiBase(ctx)}/v1/text-to-speech/${encodeURIComponent(request.voice)}/with-timestamps` +
      "?output_format=mp3_44100_128";
    const body: Record<string, unknown> = { text: request.text, model_id: request.model };
    const tuning = request.tuning;
    const settings = {
      ...(tuning
        ? {
            stability: tuning.stability,
            similarity_boost: tuning.similarity,
            style: tuning.style,
            use_speaker_boost: tuning.speakerBoost,
          }
        : {}),
      ...(speed !== 1 ? { speed } : {}),
    };
    if (Object.keys(settings).length) body["voice_settings"] = settings;
    const response = await providerFetch(
      "elevenlabs",
      LABEL,
      url,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      ctx,
    );
    const payload = (await response.json()) as { audio_base64?: unknown; alignment?: unknown };
    return {
      audio: decodeAudio(payload.audio_base64),
      appliedSpeed: speed,
      styleApplied: false,
      words: isCharacterAlignment(payload.alignment)
        ? wordsFromCharacters(payload.alignment)
        : undefined,
    };
  },
};
