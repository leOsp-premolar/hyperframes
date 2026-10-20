import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { FFPROBE_PATH_ENV, findFfBinary } from "@hyperframes/parsers/ff-binaries";

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v|mxf|mts|m2ts|ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const RASTER_IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|ico|bmp)$/i;
const SVG_EXT = /\.svg$/i;
// Decoded only when FFmpeg was built with an AV1 decoder, so a failed probe says nothing.
const OPTIONAL_DECODER_EXT = /\.avif$/i;
const SVG_SNIFF_BYTES = 64 * 1024;

/**
 * What the Assets panel and the timeline can import, by extension. The media lists mirror
 * packages/studio/src/utils/mediaTypes.ts (mediaValidation.test.ts keeps them in step): a file the
 * server accepted but Studio does not list would be added out of sight.
 */
export const STUDIO_IMPORT_EXTENSIONS = {
  video: ["mp4", "webm", "mov", "m4v"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
  font: ["woff", "woff2", "ttf", "ttc", "otf", "eot"],
} as const;

const IMPORTABLE = new Set<string>(Object.values(STUDIO_IMPORT_EXTENSIONS).flat());

/** Why a file the media import cannot use was refused, or null when it can be imported. */
export function unsupportedImportReason(fileName: string): string | null {
  const ext = extname(fileName).slice(1).toLowerCase();
  if (IMPORTABLE.has(ext)) return null;
  const kind = ext ? `.${ext} files` : "Files without an extension";
  return `${kind} can't be imported; use MP4, WebM, MOV or M4V video, an image, audio or a font`;
}

type FfprobeRunner = (
  command: string,
  args: string[],
  options: { windowsHide: boolean },
) => {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: NodeJS.ErrnoException;
};

type MediaCheck = { ok: true; unchecked?: string } | { ok: false; reason: string };

const defaultRunner = spawnSync as unknown as FfprobeRunner;
const FFPROBE_MISSING =
  "not checked: ffprobe was not found. Install FFmpeg or set HYPERFRAMES_FFPROBE_PATH.";

export function validateUploadedMedia(
  filePath: string,
  runner: FfprobeRunner = defaultRunner,
): MediaCheck {
  if (SVG_EXT.test(filePath)) return checkSvg(filePath);
  const isVideo = VIDEO_EXT.test(filePath);
  const isAudio = AUDIO_EXT.test(filePath);
  const isImage = RASTER_IMAGE_EXT.test(filePath);
  if (!isVideo && !isAudio && !isImage) {
    return { ok: true };
  }

  const ffprobe = findFfBinary("ffprobe") ?? (runner === defaultRunner ? undefined : "ffprobe");
  if (!ffprobe) return { ok: true, unchecked: FFPROBE_MISSING };
  const result = runner(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height",
      "-of",
      "json",
      "--",
      filePath,
    ],
    { windowsHide: true },
  );

  if (result.error && process.env[FFPROBE_PATH_ENV]?.trim()) {
    return {
      ok: false,
      reason: `${FFPROBE_PATH_ENV} names "${ffprobe}", which cannot run: fix it or unset it`,
    };
  }
  if (result.error?.code === "ENOENT") {
    return { ok: true, unchecked: FFPROBE_MISSING };
  }
  if (result.status !== 0) {
    if (OPTIONAL_DECODER_EXT.test(filePath)) {
      return { ok: true, unchecked: "not checked: this FFmpeg cannot decode AVIF images" };
    }
    return { ok: false, reason: damagedReason(filePath) };
  }

  if (isImage) return checkImageStream(String(result.stdout || "{}"), filePath);
  return checkStreams(String(result.stdout || "{}"), isVideo, isAudio);
}

function damagedReason(filePath: string): string {
  const ext = extname(filePath).slice(1).toUpperCase();
  return `could not be read: the file is damaged or is not really ${ext}`;
}

type ProbedStream = { codec_type?: string; width?: number; height?: number };

/** A damaged image still lists a stream, but with no size: only a sized frame counts. */
function checkImageStream(stdout: string, filePath: string): MediaCheck {
  try {
    const parsed = JSON.parse(stdout) as { streams?: ProbedStream[] };
    const sized = (parsed.streams ?? []).some(
      (stream) =>
        stream.codec_type === "video" && (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0,
    );
    return sized ? { ok: true } : { ok: false, reason: damagedReason(filePath) };
  } catch {
    return { ok: false, reason: "ffprobe returned unreadable media metadata" };
  }
}

/** An SVG is text: it must open an <svg> element near the top. FFmpeg may not read SVG at all. */
function checkSvg(filePath: string): MediaCheck {
  let head = "";
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(SVG_SNIFF_BYTES);
      head = buffer.subarray(0, readSync(fd, buffer, 0, SVG_SNIFF_BYTES, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "could not be read" };
  }
  return /<svg[\s>]/i.test(head) ? { ok: true } : { ok: false, reason: damagedReason(filePath) };
}

function checkStreams(stdout: string, isVideo: boolean, isAudio: boolean): MediaCheck {
  try {
    const parsed = JSON.parse(stdout) as { streams?: ProbedStream[] };
    const streams = parsed.streams ?? [];
    const hasVideo = streams.some((stream) => stream.codec_type === "video");
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");

    if (isVideo && !hasVideo) {
      return { ok: false, reason: "no supported video stream found" };
    }
    if (isAudio && !hasAudio) {
      return { ok: false, reason: "no supported audio stream found" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "ffprobe returned unreadable media metadata" };
  }
}

export function validateUploadedMediaBuffer(
  fileName: string,
  buffer: Uint8Array,
  runner: FfprobeRunner = defaultRunner,
): MediaCheck {
  const tempDir = mkdtempSync(join(tmpdir(), "hyperframes-upload-"));
  const tempPath = join(tempDir, basename(fileName));

  try {
    writeFileSync(tempPath, buffer);
    return validateUploadedMedia(tempPath, runner);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
