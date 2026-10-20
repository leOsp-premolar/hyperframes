import type { SpeechWord } from "./types.js";

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export function isCharacterAlignment(value: unknown): value is CharacterAlignment {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  const chars = a["characters"];
  const starts = a["character_start_times_seconds"];
  const ends = a["character_end_times_seconds"];
  return (
    Array.isArray(chars) &&
    Array.isArray(starts) &&
    Array.isArray(ends) &&
    chars.length === starts.length &&
    chars.length === ends.length &&
    chars.every((c) => typeof c === "string") &&
    starts.every((t) => typeof t === "number" && Number.isFinite(t)) &&
    ends.every((t) => typeof t === "number" && Number.isFinite(t))
  );
}

const SPOKEN = /[\p{L}\p{N}]/u;

/**
 * Words from per-character timings: whitespace separates words and punctuation stays on the word
 * it touches, as captions show it. A run of only punctuation ("…", "—") is not spoken, so it is
 * dropped rather than given a time of its own.
 */
export function wordsFromCharacters(alignment: CharacterAlignment): SpeechWord[] {
  const words: SpeechWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (SPOKEN.test(text)) words.push({ text, start, end: Math.max(start, end) });
    text = "";
  };
  alignment.characters.forEach((char, i) => {
    if (/\s/.test(char)) {
      flush();
      return;
    }
    if (!text) start = alignment.character_start_times_seconds[i] ?? 0;
    text += char;
    end = alignment.character_end_times_seconds[i] ?? end;
  });
  flush();
  return words;
}
