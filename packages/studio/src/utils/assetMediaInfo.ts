import { useEffect, useState } from "react";
import { mediaMetadataUrl } from "./studioHelpers";
import { studioApiFetch } from "./studioApiFetch";

/** What the Assets panel shows about a file, read from `/media/metadata`. */
export interface AssetMediaInfo {
  kind: "video" | "image" | "audio" | "unknown";
  width?: number;
  height?: number;
  frameRate?: number;
  /** The picture codec of a video or image. */
  codec?: string;
  hasAudio?: boolean;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const num = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined);
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const KINDS: ReadonlyArray<AssetMediaInfo["kind"]> = ["video", "image", "audio", "unknown"];
const isKind = (value: unknown): value is AssetMediaInfo["kind"] =>
  KINDS.some((kind) => kind === value);

/** The endpoint's answer as AssetMediaInfo, or null when it says nothing usable. */
export function parseAssetMediaInfo(body: unknown): AssetMediaInfo | null {
  const metadata = record(record(body).metadata);
  const kind = metadata.kind;
  if (!isKind(kind) || str(metadata.probeError)) return null;
  const audio = record(metadata.audio);
  return {
    kind,
    width: num(metadata.width),
    height: num(metadata.height),
    frameRate: num(metadata.frameRate),
    codec: str(record(metadata.color).codecName),
    hasAudio: typeof metadata.hasAudio === "boolean" ? metadata.hasAudio : undefined,
    audioCodec: str(audio.codecName),
    sampleRate: num(audio.sampleRate),
    channels: num(audio.channels),
  };
}

const CODEC_LABELS: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp8: "VP8",
  vp9: "VP9",
  prores: "ProRes",
  mpeg4: "MPEG-4",
  mjpeg: "JPEG",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  alac: "ALAC",
};

/** A codec's familiar name: `h264` → `H.264`, `pcm_s16le` → `PCM`. */
export function codecLabel(codec: string): string {
  if (codec.startsWith("pcm_")) return "PCM";
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

function channelLabel(channels: number): string {
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  return `${channels} ch`;
}

function formatRate(fps: number): string {
  return `${Number.isInteger(fps) ? fps : fps.toFixed(2).replace(/0$/, "")} fps`;
}

/** The facts a card shows, in order: size, rate, codec, sound. Empty when nothing is known. */
export function describeAssetMedia(info: AssetMediaInfo): string[] {
  const parts: string[] = [];
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`);
  if (info.kind === "video" && info.frameRate) parts.push(formatRate(info.frameRate));
  if (info.codec && info.kind !== "audio") parts.push(codecLabel(info.codec));
  if (info.kind === "video" && info.hasAudio === false) parts.push("No audio");
  if (info.audioCodec) parts.push(codecLabel(info.audioCodec));
  if (info.kind === "audio" && info.sampleRate) parts.push(`${info.sampleRate / 1000} kHz`);
  if (info.kind === "audio" && info.channels) parts.push(channelLabel(info.channels));
  return parts;
}

// One probe per file and session; each costs the server an ffprobe run, so at most a few at once.
const MAX_CONCURRENT = 3;
const cache = new Map<string, Promise<AssetMediaInfo | null>>();
const waiting: Array<() => void> = [];
let running = 0;

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Probe once per project file; a failed request is forgotten so a later card can retry. */
export function fetchAssetMediaInfo(
  projectId: string,
  asset: string,
): Promise<AssetMediaInfo | null> {
  const key = `${projectId}\u0000${asset}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = limited(async () => {
    const res = await studioApiFetch(mediaMetadataUrl(projectId, asset));
    if (!res.ok) throw new Error(`metadata answered ${res.status}`);
    return parseAssetMediaInfo(await res.json());
  }).catch(() => {
    cache.delete(key);
    return null;
  });
  cache.set(key, pending);
  return pending;
}

/** Test-only: forget every probe. */
export function resetAssetMediaInfoCache(): void {
  cache.clear();
}

/** The file's media facts once probed: undefined while loading, null when unknown. */
export function useAssetMediaInfo(
  projectId: string,
  asset: string,
): AssetMediaInfo | null | undefined {
  const [info, setInfo] = useState<AssetMediaInfo | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setInfo(undefined);
    void fetchAssetMediaInfo(projectId, asset).then((next) => {
      if (current) setInfo(next);
    });
    return () => {
      current = false;
    };
  }, [projectId, asset]);
  return info;
}
