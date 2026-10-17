import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// OpenAI text-to-speech (/v1/audio/speech), keyed by $OPENAI_API_KEY. No word
// timings come back, so the shared engine transcribes the saved audio — set
// HYPERFRAMES_TRANSCRIBE_ENGINE=openai to do that with the Whisper API too.
export const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const OPENAI_TTS_MODELS = [OPENAI_TTS_MODEL, "tts-1", "tts-1-hd"];
export const OPENAI_TTS_DEFAULT_VOICE = "alloy";
// The endpoint rejects longer input.
export const OPENAI_TTS_MAX_CHARS = 4096;

export function openaiConfigured(env = process.env) {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

function baseUrl(env) {
  return (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

// Writes wavAbs (a .wav is transcoded to the engine's 44.1k mono by `transcode`;
// any other extension gets the raw bytes). Never throws: failures return
// { ok:false, error } like the other providers.
export async function synthesizeOpenAI(
  { text, voiceId, model, style, speed = 1, wavAbs },
  { fetchImpl = fetch, env = process.env, transcode } = {},
) {
  // Callers pass null for "not set" as well as undefined.
  voiceId ??= OPENAI_TTS_DEFAULT_VOICE;
  model ??= OPENAI_TTS_MODEL;
  try {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key) throw new Error("$OPENAI_API_KEY is not set");
    if (!OPENAI_TTS_MODELS.includes(model)) {
      throw new Error(`Unsupported OpenAI TTS model: ${model} (${OPENAI_TTS_MODELS.join(" | ")})`);
    }
    if (text.length > OPENAI_TTS_MAX_CHARS) {
      throw new Error(
        `line is ${text.length} characters; OpenAI TTS accepts up to ${OPENAI_TTS_MAX_CHARS}. Split it.`,
      );
    }
    if (!(speed >= 0.25 && speed <= 4)) throw new Error("OpenAI TTS speed must be 0.25-4");
    const body = { model, input: text, voice: voiceId, response_format: "wav", speed };
    // Delivery instructions are only understood by the gpt-4o family.
    if (style && model.startsWith("gpt-")) body.instructions = style;
    const response = await fetchImpl(`${baseUrl(env)}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`OpenAI TTS HTTP ${response.status}: ${detail}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("OpenAI TTS returned no audio");
    if (wavAbs.endsWith(".wav") && transcode) {
      if (!transcode(bytes, wavAbs)) throw new Error("wav transcode failed (ffmpeg)");
    } else {
      mkdirSync(dirname(wavAbs), { recursive: true });
      writeFileSync(wavAbs, bytes);
    }
    return { ok: true, words: null };
  } catch (e) {
    return { ok: false, words: null, error: e instanceof Error ? e.message : String(e) };
  }
}
