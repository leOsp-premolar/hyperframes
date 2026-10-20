import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import { describeVoiceProviders, listVoices, synthesizeSpeech, VoiceError } from "../api/voice.js";
import type { VoiceProviderChoice } from "../voice/types.js";
import { c } from "../ui/colors.js";
import { failCommand } from "../utils/commandResult.js";

export interface CloudSpeechArgs {
  text: string;
  output: string;
  provider: VoiceProviderChoice;
  voice?: string;
  model?: string;
  speed: number;
  style?: string;
  language?: string;
  /** Where to write the word timings, as a transcript.json array. */
  wordsPath?: string;
  json: boolean;
}

function fail(err: unknown, json: boolean, spin: ReturnType<typeof clack.spinner> | null): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof VoiceError ? err.code : "failed";
  if (json) console.log(JSON.stringify({ ok: false, code, error: message }));
  else if (spin) spin.stop(c.error(`Speech synthesis failed: ${message}`));
  else console.error(c.error(message));
  failCommand();
}

/** `hyperframes tts --provider …`: the voice API, for every provider and option it has. */
export async function runCloudSpeech(args: CloudSpeechArgs): Promise<void> {
  const spin = args.json ? null : clack.spinner();
  spin?.start(`Generating speech (${args.provider})...`);
  try {
    const result = await synthesizeSpeech({
      text: args.text,
      outputPath: args.output,
      provider: args.provider,
      voice: args.voice,
      model: args.model,
      speed: args.speed,
      style: args.style,
      language: args.language,
      words: Boolean(args.wordsPath),
    });
    const wordsPath = args.wordsPath ? resolve(args.wordsPath) : undefined;
    if (wordsPath && result.words) {
      const words = result.words.map((w, i) => ({ id: `w${i}`, ...w }));
      writeFileSync(wordsPath, JSON.stringify(words, null, 2));
    }
    if (args.json) {
      console.log(
        JSON.stringify({
          ok: true,
          provider: result.provider,
          voice: result.voice,
          model: result.model,
          speed: result.speed,
          styleApplied: result.styleApplied,
          durationSeconds: result.durationSeconds,
          outputPath: result.outputPath,
          ...(wordsPath ? { wordsPath, wordsSource: result.wordsSource } : {}),
        }),
      );
      return;
    }
    spin?.stop(
      c.success(
        `Generated ${c.accent(result.durationSeconds.toFixed(1) + "s")} with ${c.accent(`${result.provider} · ${result.voice}`)} → ${c.accent(result.outputPath)}`,
      ),
    );
    if (args.style && !result.styleApplied) {
      console.log(c.dim(`  Note: ${result.provider} · ${result.model} does not take --style.`));
    }
    if (wordsPath) console.log(c.dim(`  Word timings → ${wordsPath}`));
  } catch (err) {
    fail(err, args.json, spin);
  }
}

/** `hyperframes tts --list --provider …`. */
export async function listProviderVoices(provider: VoiceProviderChoice, json: boolean) {
  try {
    const voices = await listVoices(provider);
    if (json) {
      console.log(JSON.stringify(voices));
      return;
    }
    const picked = provider === "auto" ? describeVoiceProviders().auto : provider;
    console.log(`\n${c.bold("Available voices")} (${picked})\n`);
    for (const v of voices) {
      const facts = [v.gender, v.language, v.description].filter(Boolean).join(" · ");
      console.log(`  ${c.accent(v.id.padEnd(24))} ${v.name.padEnd(16)} ${c.dim(facts)}`);
    }
    console.log("");
  } catch (err) {
    fail(err, json, null);
  }
}
