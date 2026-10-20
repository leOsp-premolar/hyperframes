/** Every format Studio's export offers; `png-sequence` downloads as a zip of frames. */
const EXPORT_FORMATS = ["mp4", "webm", "mov", "gif", "png-sequence", "wav", "mp3", "m4a"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type AudioExportFormat = "wav" | "mp3" | "m4a";
/** What the producer is asked to render; audio exports render video and keep its sound. */
export type ProducerFormat = "mp4" | "webm" | "mov" | "gif" | "png-sequence";

const EXPORT_EXT: Record<ExportFormat, string> = {
  mp4: ".mp4",
  webm: ".webm",
  mov: ".mov",
  gif: ".gif",
  "png-sequence": ".zip",
  wav: ".wav",
  mp3: ".mp3",
  m4a: ".m4a",
};

const AUDIO_FORMATS: readonly string[] = ["wav", "mp3", "m4a"];

export function isExportFormat(value: unknown): value is ExportFormat {
  return EXPORT_FORMATS.some((format) => format === value);
}

export function isAudioExportFormat(format: ExportFormat): format is AudioExportFormat {
  return AUDIO_FORMATS.includes(format);
}

/** Seconds on the composition timeline; `end` is exclusive. */
export interface ExportRange {
  start: number;
  end: number;
}

/** The shortest range an export takes: one frame at the highest rate Studio offers. */
const MIN_RANGE_SECONDS = 1 / 60;

/**
 * The request's `range`, null when there is none, or an error when it cannot be exported. A range
 * is two finite seconds, the start at or after zero and before the end.
 */
export function parseExportRange(value: unknown): ExportRange | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return { error: "range must be { start, end } in seconds" };
  const start: unknown = "start" in value ? value.start : undefined;
  const end: unknown = "end" in value ? value.end : undefined;
  if (typeof start !== "number" || typeof end !== "number") {
    return { error: "range must be { start, end } in seconds" };
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    return { error: "range start and end must be finite seconds, the start at 0 or later" };
  }
  if (end - start < MIN_RANGE_SECONDS) {
    return { error: "range end must come after its start" };
  }
  return { start, end };
}

/** How one export is made: what the producer renders, and what Studio does with it after. */
export interface ExportPlan {
  format: ExportFormat;
  producerFormat: ProducerFormat;
  /** The downloaded file's extension. */
  ext: string;
  /** Where the producer stops, in seconds; undefined renders the whole composition. */
  endSeconds?: number;
  /** Seconds cut from the head of the render; 0 keeps it all. */
  trimStart: number;
  /** Whether the producer's output needs a finishing step before it is the export. */
  needsFinish: boolean;
}

export function planExport(format: ExportFormat, range: ExportRange | null): ExportPlan {
  const audio = isAudioExportFormat(format);
  const producerFormat: ProducerFormat = audio ? "mp4" : format;
  const trimStart = range && range.start > 0 ? range.start : 0;
  return {
    format,
    producerFormat,
    ext: EXPORT_EXT[format],
    ...(range ? { endSeconds: range.end } : {}),
    trimStart,
    needsFinish: audio || format === "png-sequence" || trimStart > 0,
  };
}
