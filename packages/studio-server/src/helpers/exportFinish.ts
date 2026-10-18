import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import type { ExportPlan } from "./exportPlan.js";
import { writeStoredZip, type ZipEntry } from "./storedZip.js";

const FINISH_TIMEOUT_MS = 30 * 60_000;
// The producer's sidecar next to a PNG sequence (engine MIXED_AUDIO_FILENAME).
const SIDECAR_AUDIO = "audio.m4a";

export type FfRunner = (tool: "ffmpeg" | "ffprobe", args: string[]) => Promise<string>;

const runFf: FfRunner = (tool, args) =>
  new Promise((resolve, reject) => {
    const binary = findFfBinary(tool);
    if (!binary) {
      reject(new Error(`${tool} was not found; install FFmpeg to export this format`));
      return;
    }
    execFile(
      binary,
      args,
      { timeout: FINISH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`${tool} failed: ${String(stderr || error.message).slice(-400)}`));
        else resolve(String(stdout));
      },
    );
  });

interface StreamFacts {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  profile?: string;
  tags?: Record<string, string>;
}

async function probeStreams(file: string, run: FfRunner): Promise<StreamFacts[]> {
  const out = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", "--", file]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("streams" in parsed)) return [];
  return Array.isArray(parsed.streams) ? parsed.streams : [];
}

const seconds = (value: number) => value.toFixed(6);

const PRORES_PROFILES: Record<string, string> = {
  Proxy: "0",
  LT: "1",
  Standard: "2",
  HQ: "3",
  "4444": "4",
  "4444 XQ": "5",
};

type EncodeArgs = { input: string[]; output: string[] };

const hasAlpha = (video: StreamFacts) =>
  video.tags?.alpha_mode === "1" || video.tags?.ALPHA_MODE === "1";

const ENCODERS: Record<string, (video: StreamFacts, pixFmt: string) => EncodeArgs> = {
  hevc: (_video, pixFmt) => ({
    input: [],
    output: ["-c:v", "libx265", "-crf", "14", "-tag:v", "hvc1", "-pix_fmt", pixFmt],
  }),
  vp9: (video, pixFmt) =>
    hasAlpha(video)
      ? {
          // FFmpeg's own VP9 decoder drops the alpha plane; libvpx keeps it.
          input: ["-c:v", "libvpx-vp9"],
          output: [
            ...["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-pix_fmt", "yuva420p"],
            ...["-auto-alt-ref", "0", "-metadata:s:v:0", "alpha_mode=1"],
          ],
        }
      : {
          input: [],
          output: ["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-pix_fmt", pixFmt],
        },
  prores: (video, pixFmt) => ({
    input: [],
    output: [
      ...["-c:v", "prores_ks", "-profile:v", PRORES_PROFILES[video.profile ?? ""] ?? "4"],
      ...["-vendor", "apl0", "-pix_fmt", pixFmt],
    ],
  }),
};

/** Re-encode settings that keep the render's codec, alpha and pixel format, near-losslessly. */
function videoEncodeArgs(video: StreamFacts): EncodeArgs {
  const pixFmt = video.pix_fmt ?? "yuv420p";
  const encoder = ENCODERS[video.codec_name ?? ""];
  if (encoder) return encoder(video, pixFmt);
  return {
    input: [],
    output: ["-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", pixFmt],
  };
}

function audioEncodeArgs(audio: StreamFacts | undefined): string[] {
  if (!audio) return ["-an"];
  if (audio.codec_name === "opus") return ["-c:a", "libopus", "-b:a", "128k"];
  if (audio.codec_name?.startsWith("pcm_")) return ["-c:a", audio.codec_name];
  return ["-c:a", "aac", "-b:a", "192k"];
}

/** Cut `start` seconds from the head of a rendered video, keeping its codecs. */
async function trimVideo(work: string, output: string, start: number, run: FfRunner) {
  const streams = await probeStreams(work, run);
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error("The render has no picture to trim");
  const { input, output: videoArgs } = videoEncodeArgs(video);
  const audio = audioEncodeArgs(streams.find((s) => s.codec_type === "audio"));
  await run("ffmpeg", [
    ...["-v", "error", "-y", "-ss", seconds(start), ...input, "-i", work],
    ...["-map", "0:v:0", "-map", "0:a:0?", ...videoArgs, ...audio, output],
  ]);
}

/** Cut the head of a GIF, building a fresh palette for what is left. */
async function trimGif(work: string, output: string, start: number, run: FfRunner) {
  await run("ffmpeg", [
    ...["-v", "error", "-y", "-ss", seconds(start), "-i", work],
    ...["-filter_complex", "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse"],
    ...["-loop", "0", output],
  ]);
}

const AUDIO_CODEC: Record<string, string[]> = {
  ".wav": ["-c:a", "pcm_s16le"],
  ".mp3": ["-c:a", "libmp3lame", "-b:a", "320k"],
  ".m4a": ["-c:a", "aac", "-b:a", "192k"],
};

/** Keep only the sound of a rendered video, from `start` seconds on. */
async function extractAudio(
  work: string,
  output: string,
  ext: string,
  start: number,
  run: FfRunner,
) {
  const streams = await probeStreams(work, run);
  if (!streams.some((s) => s.codec_type === "audio")) {
    throw new Error("This composition has no sound to export");
  }
  const codec = ext === ".m4a" && start === 0 ? ["-c:a", "copy"] : (AUDIO_CODEC[ext] ?? []);
  await run("ffmpeg", [
    ...["-v", "error", "-y", ...(start > 0 ? ["-ss", seconds(start)] : []), "-i", work],
    ...["-map", "0:a:0", "-vn", ...codec, output],
  ]);
}

/** Zip a PNG sequence from frame `firstFrame` on, numbered again from 1, with its trimmed sound. */
async function zipFrames(
  workDir: string,
  output: string,
  firstFrame: number,
  start: number,
  run: FfRunner,
) {
  const frames = readdirSync(workDir)
    .filter((name) => /^frame_\d+\.png$/.test(name))
    .sort()
    .slice(firstFrame);
  if (frames.length === 0) throw new Error("The render produced no frames in the range");
  const entries: ZipEntry[] = frames.map((name, index) => ({
    name: `frame_${String(index + 1).padStart(6, "0")}.png`,
    source: join(workDir, name),
  }));
  const sidecar = join(workDir, SIDECAR_AUDIO);
  if (existsSync(sidecar)) {
    let audio = sidecar;
    if (start > 0) {
      audio = join(workDir, `trimmed-${SIDECAR_AUDIO}`);
      await run("ffmpeg", [
        ...["-v", "error", "-y", "-ss", seconds(start), "-i", sidecar],
        ...["-c:a", "aac", "-b:a", "192k", audio],
      ]);
    }
    entries.push({ name: SIDECAR_AUDIO, source: audio });
  }
  writeStoredZip(output, entries);
}

/**
 * Turn the producer's output at `work` into the export at `output`: cut the head of a range,
 * keep only the sound of an audio export, or zip a PNG sequence. On failure nothing is left at
 * `output`; `work` is the caller's to remove.
 */
export async function finishExport(input: {
  plan: ExportPlan;
  work: string;
  output: string;
  fps: number;
  run?: FfRunner;
}): Promise<void> {
  const { plan, work, output, fps } = input;
  const run = input.run ?? runFf;
  // Cut on a frame boundary, so the export starts on the frame the timeline shows there.
  const firstFrame = Math.round(plan.trimStart * fps);
  const start = firstFrame / fps;
  try {
    if (plan.format === "png-sequence") await zipFrames(work, output, firstFrame, start, run);
    else if (plan.producerFormat !== plan.format) {
      await extractAudio(work, output, plan.ext, start, run);
    } else if (plan.format === "gif") await trimGif(work, output, start, run);
    else await trimVideo(work, output, start, run);
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
}

/** A short description of the finishing step, for the progress line. */
export function finishStage(plan: ExportPlan): string {
  if (plan.format === "png-sequence") return "Packing frames";
  if (plan.producerFormat !== plan.format) return "Extracting audio";
  return "Trimming to the in/out range";
}
