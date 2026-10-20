import { spawnSync } from "node:child_process";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";

/** Whether this machine can make and probe the media a route test needs. */
export const hasFfTools = Boolean(findFfBinary("ffmpeg") && findFfBinary("ffprobe"));

/** Run ffmpeg quietly, overwriting its output. */
export function ffmpeg(...args: string[]): void {
  spawnSync(findFfBinary("ffmpeg") ?? "ffmpeg", ["-v", "error", "-y", ...args]);
}
