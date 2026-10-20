import { baseUrl, providerFetch, requireKey } from "./http.js";
import type { ProviderSpeech, VoiceProvider, VoiceSummary } from "./types.js";

const LABEL = "OpenAI";
const KEY = "OPENAI_API_KEY";
const DEFAULT_BASE = "https://api.openai.com/v1";
const STYLE_MODELS = ["gpt-4o-mini-tts"];
// tts-1 and tts-1-hd take `speed`; gpt-4o-mini-tts is slowed or sped up with atempo instead.
const NATIVE_SPEED_MODELS = new Set(["tts-1", "tts-1-hd"]);

// OpenAI has no voice listing endpoint; these are the built-in voices.
const VOICES: readonly VoiceSummary[] = [
  { id: "alloy", name: "Alloy", description: "neutral, balanced" },
  { id: "ash", name: "Ash", description: "clear, direct" },
  { id: "ballad", name: "Ballad", description: "soft, expressive" },
  { id: "coral", name: "Coral", description: "warm, friendly" },
  { id: "echo", name: "Echo", description: "resonant" },
  { id: "fable", name: "Fable", description: "storyteller" },
  { id: "nova", name: "Nova", description: "bright, energetic" },
  { id: "onyx", name: "Onyx", description: "deep" },
  { id: "sage", name: "Sage", description: "calm" },
  { id: "shimmer", name: "Shimmer", description: "light, gentle" },
  { id: "verse", name: "Verse", description: "versatile" },
  { id: "marin", name: "Marin", description: "natural; gpt-4o-mini-tts only" },
  { id: "cedar", name: "Cedar", description: "natural; gpt-4o-mini-tts only" },
];

export const openai: VoiceProvider = {
  id: "openai",
  label: LABEL,
  local: false,
  models: ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"],
  defaultModel: "gpt-4o-mini-tts",
  styleModels: STYLE_MODELS,
  nativeWords: false,
  maxCharacters: 4096,
  setupHint: `Set ${KEY} (platform.openai.com → API keys).`,

  configured(env) {
    return Boolean(env[KEY]?.trim());
  },

  defaultVoice() {
    return "coral";
  },

  async listVoices() {
    return VOICES.map((voice) => ({ ...voice }));
  },

  async synthesize(request, ctx): Promise<ProviderSpeech> {
    const key = requireKey("openai", LABEL, KEY, ctx);
    const styleApplied = Boolean(request.style) && STYLE_MODELS.includes(request.model);
    const nativeSpeed = NATIVE_SPEED_MODELS.has(request.model);
    const body: Record<string, unknown> = {
      model: request.model,
      voice: request.voice,
      input: request.text,
      response_format: "wav",
    };
    if (styleApplied) body["instructions"] = request.style;
    if (nativeSpeed && request.speed !== 1) body["speed"] = request.speed;
    const response = await providerFetch(
      "openai",
      LABEL,
      `${baseUrl(ctx.env["OPENAI_BASE_URL"], DEFAULT_BASE)}/audio/speech`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      ctx,
    );
    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      appliedSpeed: nativeSpeed ? request.speed : 1,
      styleApplied,
    };
  },
};
