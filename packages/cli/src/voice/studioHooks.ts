import type { StudioApiAdapter } from "@hyperframes/studio-server";
import {
  defaultVoiceDeps,
  describeVoiceProvidersWith,
  listVoicesWith,
  synthesizeSpeechWith,
} from "./synthesizeSpeech.js";
import { VOICE_PROVIDERS, VoiceError, isVoiceProviderChoice } from "./types.js";

export type VoiceAdapterHooks = Required<
  Pick<StudioApiAdapter, "describeVoiceProviders" | "listVoices" | "synthesizeVoice">
>;

/** The voice API as Studio server adapter hooks, shared by `hyperframes preview` and the dev server. */
export function voiceAdapterHooks(): VoiceAdapterHooks {
  return {
    describeVoiceProviders: () => describeVoiceProvidersWith(defaultVoiceDeps()),
    listVoices: (provider, signal) => listVoicesWith(defaultVoiceDeps(), provider, { signal }),
    async synthesizeVoice({ request, outputPath, signal }) {
      const provider = request.provider ?? "auto";
      if (!isVoiceProviderChoice(provider)) {
        throw new VoiceError(
          "invalid_option",
          `Unknown provider '${provider}'. Use auto, ${VOICE_PROVIDERS.join(", ")}.`,
        );
      }
      const result = await synthesizeSpeechWith(defaultVoiceDeps(), {
        ...request,
        provider,
        outputPath,
        signal,
      });
      return {
        provider: result.provider,
        voice: result.voice,
        model: result.model,
        durationSeconds: result.durationSeconds,
        speed: result.speed,
        styleApplied: result.styleApplied,
        ...(result.words ? { words: result.words, wordsSource: result.wordsSource } : {}),
      };
    },
  };
}
