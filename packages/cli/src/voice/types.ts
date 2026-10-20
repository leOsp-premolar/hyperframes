/** Engines `synthesizeSpeech` can run. The cloud ones read their API key from the environment. */
export const VOICE_PROVIDERS = ["elevenlabs", "openai", "kokoro", "studio"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number];
/** "auto": the first cloud provider with a key (ElevenLabs, then OpenAI), else Kokoro. */
export type VoiceProviderChoice = VoiceProviderId | "auto";

function isVoiceProviderId(value: unknown): value is VoiceProviderId {
  return typeof value === "string" && (VOICE_PROVIDERS as readonly string[]).includes(value);
}

export function isVoiceProviderChoice(value: unknown): value is VoiceProviderChoice {
  return value === "auto" || isVoiceProviderId(value);
}

/** Output formats, by extension. */
export const SPEECH_EXTENSIONS = [".wav", ".mp3"] as const;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const MAX_STYLE_LENGTH = 1000;

export interface SpeechWord {
  text: string;
  /** Seconds into the written file. */
  start: number;
  end: number;
}

export interface VoiceSummary {
  id: string;
  name: string;
  gender?: string;
  language?: string;
  description?: string;
  /** A short sample the provider hosts, when it has one. */
  previewUrl?: string;
}

export interface VoiceProviderSummary {
  id: VoiceProviderId;
  label: string;
  /** Runs on this machine; no account or network needed after the first model download. */
  local: boolean;
  /** Ready to use: the cloud key is set, or Kokoro's Python packages are installed. */
  configured: boolean;
  /** What to do when `configured` is false. */
  setupHint?: string;
  defaultVoice: string;
  defaultModel: string;
  /** Models known to work; a provider may accept newer ones. */
  models: readonly string[];
  /** Models that follow `style` delivery instructions. */
  styleModels: readonly string[];
  /** The provider times each word itself; the others are transcribed when words are asked for. */
  nativeWords: boolean;
  maxCharacters: number;
}

export type VoiceEnv = Readonly<Record<string, string | undefined>>;

export interface ProviderContext {
  env: VoiceEnv;
  fetch: typeof fetch;
  signal: AbortSignal;
}

/** ElevenLabs delivery settings, each 0–1. They change how a voice performs, not its sound. */
export interface VoiceTuning {
  /** Lower is more expressive and varied, higher is steadier. */
  stability: number;
  /** How closely the speech keeps to the original voice. */
  similarity: number;
  /** How much of the voice's own manner is exaggerated. */
  style: number;
  speakerBoost: boolean;
}

export interface ProviderSpeechRequest {
  text: string;
  voice: string;
  model: string;
  speed: number;
  style?: string;
  language?: string;
  /** Delivery settings, for providers that take them (ElevenLabs). */
  tuning?: VoiceTuning;
}

export interface ProviderSpeech {
  /** Encoded audio in any format ffmpeg reads. */
  audio: Uint8Array;
  /** The speed the audio already has; ffmpeg's atempo makes up the rest. */
  appliedSpeed: number;
  styleApplied: boolean;
  /** Seconds into `audio`, before any tempo change. */
  words?: SpeechWord[];
}

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  readonly label: string;
  readonly local: boolean;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly styleModels: readonly string[];
  readonly nativeWords: boolean;
  readonly maxCharacters: number;
  readonly setupHint: string;
  configured(env: VoiceEnv): boolean;
  defaultVoice(language?: string): string;
  listVoices(ctx: ProviderContext): Promise<VoiceSummary[]>;
  synthesize(request: ProviderSpeechRequest, ctx: ProviderContext): Promise<ProviderSpeech>;
}

export type VoiceErrorCode =
  | "invalid_option"
  | "text_too_long"
  | "not_configured"
  | "auth_failed"
  | "rate_limited"
  | "provider_failed"
  | "encode_failed"
  | "words_failed"
  | "cancelled";

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly provider?: VoiceProviderId;
  /** The provider's HTTP status, for auth_failed, rate_limited and provider_failed. */
  readonly status?: number;
  /** words_failed: the speech, which was written before its words could be timed. */
  readonly outputPath?: string;

  constructor(
    code: VoiceErrorCode,
    message: string,
    options: {
      cause?: unknown;
      provider?: VoiceProviderId;
      status?: number;
      outputPath?: string;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VoiceError";
    this.code = code;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.status !== undefined) this.status = options.status;
    if (options.outputPath !== undefined) this.outputPath = options.outputPath;
  }
}
