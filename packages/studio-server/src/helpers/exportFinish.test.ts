// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpeg, hasFfTools } from "../routes/ffmpegMedia.test-helpers";
import { finishExport } from "./exportFinish";
import { planExport, type ExportFormat } from "./exportPlan";

const dir = mkdtempSync(join(tmpdir(), "hf-export-finish-"));
const src = (name: string) => join(dir, name);
const PICTURE = ["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=30:duration=2"];
const TONE = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000"];

beforeAll(() => {
  if (!hasFfTools) return;
  ffmpeg(...PICTURE, ...TONE, "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src("clip.mp4"));
  ffmpeg(...PICTURE, "-pix_fmt", "yuv420p", src("silent.mp4"));
  ffmpeg(
    ...["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=30:duration=2,format=yuva420p"],
    ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"],
    ...["-metadata:s:v:0", "alpha_mode=1", src("alpha.webm")],
  );
  ffmpeg(
    ...PICTURE,
    ...["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"],
    src("clip.mov"),
  );
  ffmpeg(...PICTURE, src("clip.gif"));
  mkdirSync(src("frames"));
  ffmpeg(...PICTURE, src("frames/frame_%06d.png"));
  ffmpeg(...TONE, "-c:a", "aac", src("frames/audio.m4a"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function probe(file: string, entries: string): string {
  return spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", "--", file],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
}

const duration = (file: string) => Number(probe(file, "format=duration"));

async function finish(format: ExportFormat, work: string, start: number, name: string) {
  const output = src(name);
  rmSync(output, { force: true });
  await finishExport({ plan: planExport(format, { start, end: 2 }), work, output, fps: 30 });
  return output;
}

describe.skipIf(!hasFfTools)("finishExport", () => {
  it("cuts the head of an MP4 on a frame, keeping H.264 and the sound", async () => {
    const out = await finish("mp4", src("clip.mp4"), 0.5, "cut.mp4");
    expect(duration(out)).toBeCloseTo(1.5, 1);
    expect(probe(out, "stream=codec_name")).toBe("h264\naac");
  });

  it("keeps a WebM's alpha and a MOV's ProRes 4444 when cutting", async () => {
    const webm = await finish("webm", src("alpha.webm"), 1, "cut.webm");
    expect(probe(webm, "stream_tags=alpha_mode")).toBe("1");
    expect(duration(webm)).toBeCloseTo(1, 1);
    const mov = await finish("mov", src("clip.mov"), 1, "cut.mov");
    expect(probe(mov, "stream=codec_name,profile")).toBe("prores,4444");
  });

  it("cuts a GIF and keeps it looping", async () => {
    const out = await finish("gif", src("clip.gif"), 1, "cut.gif");
    expect(probe(out, "stream=codec_name")).toBe("gif");
    expect(duration(out)).toBeCloseTo(1, 1);
  });

  it.each([
    ["wav", "pcm_s16le"],
    ["mp3", "mp3"],
    ["m4a", "aac"],
  ] as const)("keeps only the sound for %s", async (format, codec) => {
    const out = await finish(format, src("clip.mp4"), 0.5, `sound.${format}`);
    expect(probe(out, "stream=codec_type,codec_name")).toBe(`${codec},audio`);
    expect(duration(out)).toBeCloseTo(1.5, 1);
  });

  it("says so, and leaves nothing behind, when there is no sound to export", async () => {
    await expect(finish("wav", src("silent.mp4"), 0, "none.wav")).rejects.toThrow(
      "This composition has no sound to export",
    );
    expect(existsSync(src("none.wav"))).toBe(false);
  });

  it("zips the frames from the in point, numbered from 1, with their sound", async () => {
    const out = await finish("png-sequence", src("frames"), 1, "frames.zip");
    const listing = spawnSync("unzip", ["-Z1", out], { encoding: "utf8" })
      .stdout.trim()
      .split("\n");
    expect(listing).toHaveLength(31);
    expect(listing[0]).toBe("frame_000001.png");
    expect(listing.at(-2)).toBe("frame_000030.png");
    expect(listing.at(-1)).toBe("audio.m4a");
    const unpacked = src("unpacked");
    spawnSync("unzip", ["-q", out, "-d", unpacked]);
    expect(duration(join(unpacked, "audio.m4a"))).toBeCloseTo(1, 1);
  });
});
