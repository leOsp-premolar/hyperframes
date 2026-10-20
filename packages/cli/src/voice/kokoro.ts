import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KOKORO_MODULES, KOKORO_PIP } from "../audio/providers.js";
import {
  BUNDLED_VOICES,
  DEFAULT_VOICE,
  inferLangFromVoiceId,
  isSupportedLang,
  type SupportedLang,
} from "../tts/manager.js";
import { hasPythonModules } from "../tts/python.js";
import { synthesize } from "../tts/synthesize.js";
import { VoiceError, type ProviderSpeech, type VoiceProvider } from "./types.js";

// ISO 639-1 codes callers pass, to the phonemizer locale Kokoro takes and a voice for it.
const BY_LANGUAGE: Record<string, { lang: SupportedLang; voice: string }> = {
  en: { lang: "en-us", voice: DEFAULT_VOICE },
  "en-us": { lang: "en-us", voice: DEFAULT_VOICE },
  "en-gb": { lang: "en-gb", voice: "bf_emma" },
  es: { lang: "es", voice: "ef_dora" },
  fr: { lang: "fr-fr", voice: "ff_siwis" },
  hi: { lang: "hi", voice: "hf_alpha" },
  it: { lang: "it", voice: "if_sara" },
  ja: { lang: "ja", voice: "jf_alpha" },
  pt: { lang: "pt-br", voice: "pf_dora" },
  zh: { lang: "zh", voice: "zf_xiaobei" },
};

function forLanguage(language: string | undefined) {
  if (!language) return undefined;
  const code = language.toLowerCase();
  return BY_LANGUAGE[code] ?? BY_LANGUAGE[code.split("-")[0] ?? ""];
}

/** The phonemizer locale: the text's language when Kokoro knows it, else the voice's own. */
export function kokoroLang(voice: string, language: string | undefined): SupportedLang {
  const requested = language?.toLowerCase();
  if (requested && isSupportedLang(requested)) return requested;
  return forLanguage(language)?.lang ?? inferLangFromVoiceId(voice);
}

export const kokoro: VoiceProvider = {
  id: "kokoro",
  label: "Kokoro (local)",
  local: true,
  models: ["kokoro-v1.0"],
  defaultModel: "kokoro-v1.0",
  styleModels: [],
  nativeWords: false,
  maxCharacters: 20_000,
  setupHint: KOKORO_PIP,

  configured() {
    return hasPythonModules(KOKORO_MODULES);
  },

  defaultVoice(language) {
    return forLanguage(language)?.voice ?? DEFAULT_VOICE;
  },

  async listVoices() {
    return BUNDLED_VOICES.map((v) => ({
      id: v.id,
      name: v.label,
      gender: v.gender,
      language: v.language,
    }));
  },

  async synthesize(request, ctx): Promise<ProviderSpeech> {
    const dir = mkdtempSync(join(tmpdir(), "hf-voice-kokoro-"));
    try {
      const wav = join(dir, "speech.wav");
      try {
        await synthesize(request.text, wav, {
          voice: request.voice,
          speed: request.speed,
          lang: kokoroLang(request.voice, request.language),
          signal: ctx.signal,
        });
      } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        const why = err instanceof Error ? err.message : String(err);
        throw new VoiceError("provider_failed", why, { provider: "kokoro", cause: err });
      }
      return { audio: readFileSync(wav), appliedSpeed: request.speed, styleApplied: false };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
