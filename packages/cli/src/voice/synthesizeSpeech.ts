import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { runTranscribe } from "../api/transcribe.js";
import { loadTranscript } from "../whisper/normalize.js";
import { writeSpeechFile } from "./audioFile.js";
import { elevenlabs } from "./elevenlabs.js";
import { kokoro } from "./kokoro.js";
import { openai } from "./openai.js";
import { studio } from "./studioVoices.js";
import {
  MAX_SPEED,
  MAX_STYLE_LENGTH,
  MIN_SPEED,
  SPEECH_EXTENSIONS,
  VOICE_PROVIDERS,
  VoiceError,
  isVoiceProviderChoice,
  type ProviderContext,
  type SpeechWord,
  type VoiceEnv,
  type VoiceProvider,
  type VoiceProviderChoice,
  type VoiceProviderId,
  type VoiceProviderSummary,
  type VoiceSummary,
} from "./types.js";

export interface SynthesizeSpeechOptions {
  text: string;
  /** .wav or .mp3, written as 44.1 kHz mono. An existing file is replaced. */
  outputPath: string;
  /** Default "auto": ElevenLabs, then OpenAI, whichever has a key; else Kokoro on this machine. */
  provider?: VoiceProviderChoice;
  /** Default: the provider's default voice for `language`. */
  voice?: string;
  /** Default: the provider's best model (eleven_multilingual_v2, gpt-4o-mini-tts). */
  model?: string;
  /** 0.5–2, default 1. Pitch is kept. */
  speed?: number;
  /**
   * How to say it, in plain words: "warm and tender, unhurried, smiling". Providers that take
   * delivery instructions follow it (OpenAI gpt-4o-mini-tts); the result says whether it was used.
   */
  style?: string;
  /** The text's language as an ISO 639-1 code, e.g. "es". Picks a default voice that speaks it. */
  language?: string;
  /** Also time each word: the provider's own timings, or a local transcription of the speech. */
  words?: boolean;
  /** Seconds to wait for the provider and the encode. Default 120. */
  timeoutSeconds?: number;
  /** Aborting it stops the request and any child process; the call rejects with "cancelled". */
  signal?: AbortSignal;
}

export interface SynthesizeSpeechResult {
  provider: VoiceProviderId;
  voice: string;
  model: string;
  outputPath: string;
  durationSeconds: number;
  speed: number;
  /** Whether `style` reached the provider. */
  styleApplied: boolean;
  /** Present when `words` was asked for. */
  words?: SpeechWord[];
  wordsSource?: "provider" | "transcription";
}

export interface VoiceProvidersSummary {
  /** The provider "auto" picks right now. */
  auto: VoiceProviderId;
  providers: VoiceProviderSummary[];
}

export interface VoiceDeps {
  env: VoiceEnv;
  fetch: typeof fetch;
  providers: Readonly<Record<VoiceProviderId, VoiceProvider>>;
  writeSpeech: typeof writeSpeechFile;
  transcribeWords: (
    file: string,
    language: string | undefined,
    signal: AbortSignal,
  ) => Promise<SpeechWord[]>;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const LIST_TIMEOUT_SECONDS = 30;
const AUTO_ORDER: readonly VoiceProviderId[] = ["elevenlabs", "openai"];
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

async function transcribeWords(
  file: string,
  language: string | undefined,
  signal: AbortSignal,
): Promise<SpeechWord[]> {
  const dir = mkdtempSync(join(tmpdir(), "hf-voice-words-"));
  try {
    const result = await runTranscribe({ input: file, dir, language, signal });
    if (result.kind !== "transcribed") return [];
    return loadTranscript(result.transcriptPath).words.map(({ text, start, end }) => ({
      text,
      start,
      end,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function defaultVoiceDeps(): VoiceDeps {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    providers: { elevenlabs, openai, kokoro, studio },
    writeSpeech: writeSpeechFile,
    transcribeWords,
  };
}

/** An explicit cloud choice must have its key; "auto" falls back to Kokoro, which needs none. */
export function pickProvider(
  choice: VoiceProviderChoice,
  deps: Pick<VoiceDeps, "env" | "providers">,
): VoiceProvider {
  if (choice !== "auto") {
    const provider = deps.providers[choice];
    if (!provider.local && !provider.configured(deps.env)) {
      throw new VoiceError(
        "not_configured",
        `${provider.label} is not set up. ${provider.setupHint}`,
        { provider: provider.id },
      );
    }
    return provider;
  }
  const cloud = AUTO_ORDER.map((id) => deps.providers[id]).find((p) => p.configured(deps.env));
  return cloud ?? deps.providers.kokoro;
}

interface ValidOptions {
  text: string;
  outputPath: string;
  provider: VoiceProviderChoice;
  speed: number;
  style?: string;
  language?: string;
  timeoutMs: number;
}

function invalid(message: string): VoiceError {
  return new VoiceError("invalid_option", message);
}

// fallow-ignore-next-line complexity
function validate(options: SynthesizeSpeechOptions): ValidOptions {
  // Typed callers cannot get these wrong; plain JavaScript and HTTP callers can.
  const text = typeof options.text === "string" ? options.text.trim() : "";
  if (!text) throw invalid("There is no text to speak.");
  if (typeof options.outputPath !== "string" || !options.outputPath) {
    throw invalid("outputPath is required.");
  }
  const ext = extname(options.outputPath).toLowerCase();
  if (!(SPEECH_EXTENSIONS as readonly string[]).includes(ext)) {
    throw invalid(`outputPath must end in ${SPEECH_EXTENSIONS.join(" or ")}.`);
  }
  const provider = options.provider ?? "auto";
  if (!isVoiceProviderChoice(provider)) {
    throw invalid(
      `Unknown provider '${String(provider)}'. Use auto, ${VOICE_PROVIDERS.join(", ")}.`,
    );
  }
  const speed = options.speed ?? 1;
  if (
    typeof speed !== "number" ||
    !Number.isFinite(speed) ||
    speed < MIN_SPEED ||
    speed > MAX_SPEED
  ) {
    throw invalid(`speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}.`);
  }
  const style = options.style?.trim() || undefined;
  if (style && style.length > MAX_STYLE_LENGTH) {
    throw invalid(`style must be at most ${MAX_STYLE_LENGTH} characters.`);
  }
  const language = options.language?.trim() || undefined;
  if (language && !LANGUAGE.test(language)) {
    throw invalid(`language must be a language code such as "es" or "en-gb", not '${language}'.`);
  }
  const seconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) throw invalid("timeoutSeconds must be positive.");
  return {
    text,
    outputPath: resolve(options.outputPath),
    provider,
    speed,
    style,
    language,
    timeoutMs: seconds * 1000,
  };
}

/** A stop becomes "cancelled" when the caller asked for it, and a timeout when it ran out. */
function stopped(
  err: unknown,
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
  what: string,
): unknown {
  if (caller?.aborted) return new VoiceError("cancelled", "Speech was cancelled.", { cause: err });
  if (timeout.aborted) {
    return new VoiceError("provider_failed", `${what} did not finish in time.`, { cause: err });
  }
  return err;
}

function withTimeout(caller: AbortSignal | undefined, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  return { timeout, signal: caller ? AbortSignal.any([caller, timeout]) : timeout };
}

function scaleWords(words: SpeechWord[], tempo: number): SpeechWord[] {
  return words.map((w) => ({ text: w.text, start: w.start / tempo, end: w.end / tempo }));
}

export async function synthesizeSpeechWith(
  deps: VoiceDeps,
  options: SynthesizeSpeechOptions,
): Promise<SynthesizeSpeechResult> {
  const valid = validate(options);
  const provider = pickProvider(valid.provider, deps);
  if (valid.text.length > provider.maxCharacters) {
    throw new VoiceError(
      "text_too_long",
      `${provider.label} speaks at most ${provider.maxCharacters} characters at once; this text has ${valid.text.length}. Split it into lines.`,
      { provider: provider.id },
    );
  }
  const voice = options.voice?.trim() || provider.defaultVoice(valid.language);
  const model = options.model?.trim() || provider.defaultModel;
  const { timeout, signal } = withTimeout(options.signal, valid.timeoutMs);
  if (options.signal?.aborted) throw stopped(options.signal.reason, options.signal, timeout, "");
  const ctx: ProviderContext = { env: deps.env, fetch: deps.fetch, signal };
  const speak = async () => {
    const speech = await provider.synthesize(
      {
        text: valid.text,
        voice,
        model,
        speed: valid.speed,
        style: valid.style,
        language: valid.language,
      },
      ctx,
    );
    const tempo = valid.speed / speech.appliedSpeed;
    const durationSeconds = await deps.writeSpeech(speech.audio, valid.outputPath, {
      tempo,
      filters: speech.filters,
      signal,
    });
    return { speech, tempo, durationSeconds };
  };
  const { speech, tempo, durationSeconds } = await speak().catch((err: unknown) => {
    throw stopped(err, options.signal, timeout, provider.label);
  });

  const result: SynthesizeSpeechResult = {
    provider: provider.id,
    voice,
    model,
    outputPath: valid.outputPath,
    durationSeconds,
    speed: valid.speed,
    styleApplied: speech.styleApplied,
  };
  if (!options.words) return result;
  if (speech.words?.length) {
    return { ...result, words: scaleWords(speech.words, tempo), wordsSource: "provider" };
  }
  try {
    const words = await deps.transcribeWords(valid.outputPath, valid.language, signal);
    return { ...result, words, wordsSource: "transcription" };
  } catch (err) {
    const reason = stopped(err, options.signal, timeout, "Word timing");
    if (reason instanceof VoiceError && reason.code === "cancelled") throw reason;
    const why = err instanceof Error ? err.message : String(err);
    throw new VoiceError(
      "words_failed",
      `The speech was written to ${valid.outputPath}, but its words could not be timed: ${why}`,
      { provider: provider.id, outputPath: valid.outputPath, cause: err },
    );
  }
}

export function describeVoiceProvidersWith(
  deps: Pick<VoiceDeps, "env" | "providers">,
): VoiceProvidersSummary {
  const providers = VOICE_PROVIDERS.map((id) => {
    const p = deps.providers[id];
    const configured = p.configured(deps.env);
    return {
      id: p.id,
      label: p.label,
      local: p.local,
      configured,
      ...(configured ? {} : { setupHint: p.setupHint }),
      defaultVoice: p.defaultVoice(),
      defaultModel: p.defaultModel,
      models: [...p.models],
      styleModels: [...p.styleModels],
      nativeWords: p.nativeWords,
      maxCharacters: p.maxCharacters,
    };
  });
  return { auto: pickProvider("auto", deps).id, providers };
}

export async function listVoicesWith(
  deps: VoiceDeps,
  choice: string,
  options: { signal?: AbortSignal } = {},
): Promise<VoiceSummary[]> {
  if (!isVoiceProviderChoice(choice)) {
    throw invalid(`Unknown provider '${String(choice)}'. Use auto, ${VOICE_PROVIDERS.join(", ")}.`);
  }
  const provider = pickProvider(choice, deps);
  const { timeout, signal } = withTimeout(options.signal, LIST_TIMEOUT_SECONDS * 1000);
  try {
    return await provider.listVoices({ env: deps.env, fetch: deps.fetch, signal });
  } catch (err) {
    throw stopped(err, options.signal, timeout, provider.label);
  }
}
