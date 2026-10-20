import {
  defaultVoiceDeps,
  describeVoiceProvidersWith,
  listVoicesWith,
  synthesizeSpeechWith,
  type SynthesizeSpeechOptions,
  type SynthesizeSpeechResult,
  type VoiceProvidersSummary,
} from "../voice/synthesizeSpeech.js";
import type { VoiceProviderChoice, VoiceSummary } from "../voice/types.js";

export {
  MAX_SPEED,
  MIN_SPEED,
  SPEECH_EXTENSIONS,
  VOICE_PROVIDERS,
  VoiceError,
  isVoiceProviderChoice,
  type SpeechWord,
  type VoiceErrorCode,
  type VoiceProviderChoice,
  type VoiceProviderId,
  type VoiceProviderSummary,
  type VoiceSummary,
} from "../voice/types.js";
export type {
  SynthesizeSpeechOptions,
  SynthesizeSpeechResult,
  VoiceProvidersSummary,
} from "../voice/synthesizeSpeech.js";

/**
 * Speak `text` into `outputPath` with ElevenLabs, OpenAI or Kokoro. Keys come from
 * ELEVENLABS_API_KEY and OPENAI_API_KEY; known failures throw VoiceError with a `code`.
 */
export function synthesizeSpeech(
  options: SynthesizeSpeechOptions,
): Promise<SynthesizeSpeechResult> {
  return synthesizeSpeechWith(defaultVoiceDeps(), options);
}

/** Every provider, whether it is set up, and the one "auto" would use. Never returns a key. */
export function describeVoiceProviders(): VoiceProvidersSummary {
  return describeVoiceProvidersWith(defaultVoiceDeps());
}

/** A provider's voices; ElevenLabs lists the account's library, the others a built-in set. */
export function listVoices(
  provider: VoiceProviderChoice,
  options: { signal?: AbortSignal } = {},
): Promise<VoiceSummary[]> {
  return listVoicesWith(defaultVoiceDeps(), provider, options);
}
