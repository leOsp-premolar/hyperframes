import { execFile } from "node:child_process";
import { extname } from "node:path";
import {
  firstFrameColourArgs,
  parseFirstFrameColour,
  type ToneMapSourceColour,
} from "@hyperframes/core";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";

export interface FfprobeRunResult {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  /** Spawn-level failure (covers both `NodeJS.ErrnoException` and
   * `ExecFileException`); only `code === "ENOENT"` is ever inspected. */
  error?: { code?: string | number | null | undefined };
}

/** Injectable ffprobe runner. May be synchronous (tests) or async (the
 * default `execFile`-based runner below), so cold scans can run many probes
 * concurrently off the event loop. */
export type FfprobeRunner = (
  command: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
) => FfprobeRunResult | Promise<FfprobeRunResult>;

/** Default runner: genuinely async (`execFile`), unlike the previous
 * `spawnSync`-based one — a pool of concurrent probes actually parallelizes
 * (mirrors `execFileAsync` in packages/lint/src/hevcPreviewLint.ts). */
const execFileRunner: FfprobeRunner = (command, args, options) =>
  new Promise<FfprobeRunResult>((resolvePromise) => {
    execFile(
      command,
      args,
      { timeout: options?.timeout, maxBuffer: options?.maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          resolvePromise({ status: null, stdout: "", stderr: "", error });
          return;
        }
        if (error) {
          // Nonzero exit / timeout / kill: report a nonzero status; callers
          // only distinguish "ok" (0) from "failed" from "ENOENT".
          const status = typeof error.code === "number" ? error.code : 1;
          resolvePromise({ status, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        resolvePromise({ status: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

export type MediaDynamicRange = "hdr" | "sdr" | "unknown";
export type MediaHdrTransfer = "pq" | "hlg" | "unknown";

export interface MediaColorMetadata {
  dynamicRange: MediaDynamicRange;
  hdrTransfer: MediaHdrTransfer | null;
  label: string;
  isHdr: boolean;
  codecName?: string;
  profile?: string;
  pixelFormat?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  bitsPerRawSample?: string;
}

export interface MediaAudioMetadata {
  codecName?: string;
  sampleRate?: number;
  channels?: number;
}

export interface MediaMetadata {
  kind: "video" | "image" | "audio" | "unknown";
  color: MediaColorMetadata;
  /** Video audio stream, when probed. Absent means the drop path stays muted. */
  hasAudio?: boolean;
  /** Picture size of a video or image. */
  width?: number;
  height?: number;
  /** Frames per second of a video, from its average frame rate. */
  frameRate?: number;
  durationSeconds?: number;
  /** The first audio stream: a video's soundtrack, or an audio file's own. */
  audio?: MediaAudioMetadata;
  probeError?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  profile?: string;
  pix_fmt?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  bits_per_raw_sample?: string;
  disposition?: { attached_pic?: number };
}

const VIDEO_EXT = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".mxf",
  ".mts",
  ".m2ts",
  ".ts",
]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);

function lower(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

function inferKindFromPath(path: string): MediaMetadata["kind"] {
  const ext = extname(path).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "unknown";
}

function colorLabel(input: {
  isHdr: boolean;
  hdrTransfer: MediaHdrTransfer | null;
  colorPrimaries: string;
  colorSpace: string;
  colorTransfer: string;
}): string {
  if (input.isHdr) {
    if (input.hdrTransfer === "pq") return "HDR PQ";
    if (input.hdrTransfer === "hlg") return "HDR HLG";
    return "HDR";
  }
  if (
    input.colorPrimaries.includes("bt709") ||
    input.colorSpace.includes("bt709") ||
    input.colorTransfer.includes("bt709")
  ) {
    return "SDR Rec.709";
  }
  return "SDR/unknown";
}

// Conservative alpha-bearing pix_fmt list: yuva* (yuva420p, yuva444p10le...),
// rgba/argb/bgra/abgr (packed RGB+alpha), gbrap* (planar GBR+alpha, ProRes
// 4444 decodes to these), ya* (gray+alpha). Prefix match keeps bit-depth /
// endianness suffixes covered.
const ALPHA_PIX_FMT_RE = /^(?:yuva|rgba|argb|bgra|abgr|gbrap|ya)/;

/** True when an ffprobe `pix_fmt` carries an alpha component. */
export function pixelFormatHasAlpha(pixFmt: string | undefined): boolean {
  return pixFmt !== undefined && ALPHA_PIX_FMT_RE.test(pixFmt.toLowerCase());
}

export function classifyMediaColor(stream: FfprobeStream | null | undefined): MediaColorMetadata {
  const colorPrimaries = lower(stream?.color_primaries);
  const colorSpace = lower(stream?.color_space);
  const colorTransfer = lower(stream?.color_transfer);
  const isHdr =
    colorPrimaries.includes("bt2020") ||
    colorSpace.includes("bt2020") ||
    colorTransfer === "smpte2084" ||
    colorTransfer === "arib-std-b67";
  const hdrTransfer: MediaHdrTransfer | null = isHdr
    ? colorTransfer === "smpte2084"
      ? "pq"
      : colorTransfer === "arib-std-b67"
        ? "hlg"
        : "unknown"
    : null;

  return {
    dynamicRange: stream ? (isHdr ? "hdr" : "sdr") : "unknown",
    hdrTransfer,
    label: stream
      ? colorLabel({ isHdr, hdrTransfer, colorPrimaries, colorSpace, colorTransfer })
      : "Unknown",
    isHdr,
    codecName: stream?.codec_name,
    profile: stream?.profile,
    pixelFormat: stream?.pix_fmt,
    colorSpace: stream?.color_space,
    colorTransfer: stream?.color_transfer,
    colorPrimaries: stream?.color_primaries,
    bitsPerRawSample: stream?.bits_per_raw_sample,
  };
}

/** The first shown frame's colour tags, which zscale reads per frame. Empty when unread. */
export async function probeFirstFrameColour(
  filePath: string,
  runner: FfprobeRunner = execFileRunner,
): Promise<ToneMapSourceColour> {
  const ffmpegPath =
    findFfBinary("ffmpeg", { configuredMustExist: true }) ??
    (runner === execFileRunner ? undefined : "ffmpeg");
  if (!ffmpegPath) return {};
  const result = await runner(ffmpegPath, firstFrameColourArgs(filePath), {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? parseFirstFrameColour(String(result.stderr)) : {};
}

const PROBE_ENTRIES =
  "stream=codec_type,codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,bits_per_raw_sample,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels:stream_disposition=attached_pic:format=duration";

type ProbeOutcome = { streams: FfprobeStream[]; durationSeconds?: number } | { probeError: string };

function ffprobeFor(runner: FfprobeRunner): string | undefined {
  return (
    findFfBinary("ffprobe", { configuredMustExist: true }) ??
    (runner === execFileRunner ? undefined : "ffprobe")
  );
}

async function runProbe(filePath: string, runner: FfprobeRunner): Promise<ProbeOutcome> {
  const ffprobePath = ffprobeFor(runner);
  if (!ffprobePath) return { probeError: "ffprobe unavailable" };

  const result = await runner(
    ffprobePath,
    ["-v", "error", "-show_entries", PROBE_ENTRIES, "-of", "json", "--", filePath],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error?.code === "ENOENT") return { probeError: "ffprobe unavailable" };
  if (result.status !== 0) return { probeError: "ffprobe failed" };
  return parseProbeOutput(result.stdout);
}

function parseProbeOutput(stdout: string | Buffer): ProbeOutcome {
  try {
    const parsed = JSON.parse(String(stdout || "{}")) as {
      streams?: FfprobeStream[];
      format?: { duration?: string };
    };
    return { streams: parsed.streams ?? [], durationSeconds: positive(parsed.format?.duration) };
  } catch {
    return { probeError: "ffprobe returned invalid json" };
  }
}

function positive(value: string | number | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** "30000/1001" → 29.97; "0/0" and missing rates → undefined. */
export function parseFrameRate(rate: string | undefined): number | undefined {
  const [num = Number.NaN, den = 1] = (rate ?? "").split("/").map(Number);
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : undefined;
}

function audioOf(stream: FfprobeStream | undefined): MediaAudioMetadata | undefined {
  if (!stream) return undefined;
  return {
    codecName: stream.codec_name,
    sampleRate: positive(stream.sample_rate),
    channels: positive(stream.channels),
  };
}

export async function probeMediaMetadata(
  filePath: string,
  runner: FfprobeRunner = execFileRunner,
): Promise<MediaMetadata> {
  const kind = inferKindFromPath(filePath);
  if (kind === "audio" || kind === "unknown") {
    return { kind, color: classifyMediaColor(null) };
  }

  const probe = await runProbe(filePath, runner);
  if ("probeError" in probe) {
    return { kind, color: classifyMediaColor(null), probeError: probe.probeError };
  }

  const stream = probe.streams.find((item) => {
    if (kind === "image") return item.codec_type === "video";
    return item.codec_type === kind && item.disposition?.attached_pic !== 1;
  });
  const metadata: MediaMetadata = {
    kind,
    color: classifyMediaColor(stream),
    width: positive(stream?.width),
    height: positive(stream?.height),
  };
  if (kind === "video") {
    const audio = probe.streams.find((item) => item.codec_type === "audio");
    metadata.hasAudio = audio !== undefined;
    metadata.frameRate =
      parseFrameRate(stream?.avg_frame_rate) ?? parseFrameRate(stream?.r_frame_rate);
    metadata.durationSeconds = probe.durationSeconds;
    metadata.audio = audioOf(audio);
  }
  return metadata;
}

/**
 * Everything the Assets panel shows about a file. Unlike `probeMediaMetadata`, which bulk
 * scans call and which skips audio files, this also probes audio for its codec and length.
 */
export async function probeMediaDetails(
  filePath: string,
  runner: FfprobeRunner = execFileRunner,
): Promise<MediaMetadata> {
  if (inferKindFromPath(filePath) !== "audio") return probeMediaMetadata(filePath, runner);
  const probe = await runProbe(filePath, runner);
  if ("probeError" in probe) {
    return { kind: "audio", color: classifyMediaColor(null), probeError: probe.probeError };
  }
  const audio = probe.streams.find((item) => item.codec_type === "audio");
  return {
    kind: "audio",
    color: classifyMediaColor(null),
    hasAudio: audio !== undefined,
    durationSeconds: probe.durationSeconds,
    audio: audioOf(audio),
  };
}
