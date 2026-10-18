import type { SelectOption } from "../ui/Select";

/** Mirrors studio-server's helpers/exportPlan.ts; `png-sequence` downloads as a zip of frames. */
export type ExportFormat = "mp4" | "webm" | "mov" | "gif" | "png-sequence" | "wav" | "mp3" | "m4a";
export type ExportFps = 24 | 30 | 60;

const EXPORT_FORMATS: readonly ExportFormat[] = [
  "mp4",
  "mov",
  "webm",
  "gif",
  "png-sequence",
  "wav",
  "mp3",
  "m4a",
];

export const FORMAT_INFO: Record<ExportFormat, { label: string; desc: string }> = {
  mp4: { label: "MP4", desc: "Best for general use. Smallest file, universal playback." },
  mov: {
    label: "MOV (ProRes 4444)",
    desc: "Transparent video. Works in Final Cut Pro, DaVinci Resolve, and most video editors. Large files.",
  },
  webm: {
    label: "WebM (VP9)",
    desc: "Transparent video for web. Smaller than MOV but limited editor support.",
  },
  gif: {
    label: "GIF",
    desc: "Looping animation without sound, for chats and docs. Up to 30 fps; large for long clips.",
  },
  "png-sequence": {
    label: "PNG sequence",
    desc: "One transparent PNG per frame, zipped, with the sound as audio.m4a. For compositing.",
  },
  wav: { label: "WAV", desc: "The mixed sound only, uncompressed." },
  mp3: { label: "MP3", desc: "The mixed sound only, compressed (320 kbps)." },
  m4a: { label: "M4A (AAC)", desc: "The mixed sound only, as AAC." },
};

const OPTION_LABEL: Record<ExportFormat, string> = {
  mp4: "MP4",
  mov: "MOV (ProRes)",
  webm: "WebM",
  gif: "GIF",
  "png-sequence": "PNG sequence (.zip)",
  wav: "Audio: WAV",
  mp3: "Audio: MP3",
  m4a: "Audio: M4A",
};

export const FORMAT_OPTIONS: SelectOption[] = EXPORT_FORMATS.map((value) => ({
  value,
  label: OPTION_LABEL[value],
}));

export function isExportFormat(value: unknown): value is ExportFormat {
  return EXPORT_FORMATS.some((format) => format === value);
}

function isAudioFormat(format: ExportFormat): boolean {
  return format === "wav" || format === "mp3" || format === "m4a";
}

/** Whether the export has a picture, so frame rate and resolution apply. */
export const hasPicture = (format: ExportFormat) => !isAudioFormat(format);

/** Quality only steers the lossy video encoders. */
export const hasQuality = (format: ExportFormat) => format === "mp4" || format === "webm";

/** GIF frame delays are whole centiseconds, so the producer caps GIF at 30 fps. */
export function fpsOptionsFor(format: ExportFormat): ExportFps[] {
  return format === "gif" ? [24, 30] : [24, 30, 60];
}

export const EXPORT_EXT: Record<ExportFormat, string> = {
  mp4: ".mp4",
  webm: ".webm",
  mov: ".mov",
  gif: ".gif",
  "png-sequence": ".zip",
  wav: ".wav",
  mp3: ".mp3",
  m4a: ".m4a",
};

/** How a finished render shows in the list, from its file name. */
export function renderKind(filename: string): "video" | "gif" | "audio" | "frames" {
  if (/\.gif$/i.test(filename)) return "gif";
  if (/\.zip$/i.test(filename)) return "frames";
  if (/\.(wav|mp3|m4a)$/i.test(filename)) return "audio";
  return "video";
}

/** Seconds on the timeline, end exclusive. */
export interface ExportRange {
  start: number;
  end: number;
}

/**
 * The in/out range the timeline marks, or null when neither point is set. One point alone spans
 * to the other end of the timeline; a range shorter than a frame at 60 fps is no range.
 */
export function markedRange(
  inPoint: number | null,
  outPoint: number | null,
  duration: number,
): ExportRange | null {
  if (inPoint === null && outPoint === null) return null;
  const start = Math.max(0, inPoint ?? 0);
  const end = Math.min(duration > 0 ? duration : Number.POSITIVE_INFINITY, outPoint ?? duration);
  return Number.isFinite(end) && end - start >= 1 / 60 ? { start, end } : null;
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** "00:01.50 to 00:03.00 (1.50s)" */
export function describeRange(range: ExportRange): string {
  return `${clock(range.start)} to ${clock(range.end)} (${(range.end - range.start).toFixed(2)}s)`;
}
