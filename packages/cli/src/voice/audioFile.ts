import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { probeAudio } from "../audio/analysis/decode.js";
import { stoppableExecFile } from "../utils/stoppableExecFile.js";
import { VoiceError } from "./types.js";

// The format is named, not read from the extension, because the file is first written under a
// name with no media extension.
const CODEC_ARGS: Record<string, string[]> = {
  ".wav": ["-c:a", "pcm_s16le", "-f", "wav"],
  ".mp3": ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"],
};

/**
 * Writes provider audio to `outputPath` as 44.1 kHz mono in the extension's format, changing its
 * tempo by `tempo` (0.5–2, pitch kept), and returns its length in seconds. The file appears whole
 * or not at all: ffmpeg writes beside it under a name no media list shows, and the result is
 * renamed into place, so a project watcher never lists half a file.
 */
const rubberbandByBinary = new Map<string, boolean>();

/** Studio voices need ffmpeg built with librubberband; some minimal builds leave it out. */
function hasRubberband(ffmpeg: string): boolean {
  let known = rubberbandByBinary.get(ffmpeg);
  if (known === undefined) {
    const list = execFileSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8" });
    known = /\srubberband\s/.test(list);
    rubberbandByBinary.set(ffmpeg, known);
  }
  return known;
}

export async function writeSpeechFile(
  audio: Uint8Array,
  outputPath: string,
  options: { tempo: number; filters?: string; signal: AbortSignal },
): Promise<number> {
  const ext = extname(outputPath).toLowerCase();
  const codec = CODEC_ARGS[ext];
  if (!codec) {
    throw new VoiceError("invalid_option", `Speech is written as .wav or .mp3, not '${ext}'.`);
  }
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) {
    throw new VoiceError(
      "encode_failed",
      "ffmpeg is required to write speech; run: npx hyperframes doctor",
    );
  }
  if (options.filters?.includes("rubberband") && !hasRubberband(ffmpeg)) {
    throw new VoiceError(
      "encode_failed",
      "Studio voices need ffmpeg with the rubberband filter (librubberband); install a full ffmpeg build.",
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), "hf-voice-"));
  const partial = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.partial`);
  try {
    const source = join(scratch, "provider-audio");
    writeFileSync(source, audio);
    mkdirSync(dirname(outputPath), { recursive: true });
    const chain = [
      ...(Math.abs(options.tempo - 1) > 1e-3 ? [`atempo=${options.tempo}`] : []),
      ...(options.filters ? [options.filters] : []),
    ];
    const filter = chain.length ? ["-af", chain.join(",")] : [];
    const args = ["-y", "-v", "error", "-i", source, ...filter, "-ar", "44100", "-ac", "1"];
    await stoppableExecFile(ffmpeg, [...args, ...codec, partial], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
      signal: options.signal,
    });
    renameSync(partial, outputPath);
  } catch (err) {
    rmSync(partial, { force: true });
    if (options.signal.aborted || err instanceof VoiceError) throw err;
    const why = err instanceof Error ? err.message.split("\n").slice(-2).join(" ").trim() : "";
    throw new VoiceError("encode_failed", `Could not write ${basename(outputPath)}: ${why}`, {
      cause: err,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const stream = await probeAudio(outputPath);
  return stream?.duration ?? 0;
}
