import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import {
  classifyMediaColor,
  parseFrameRate,
  pixelFormatHasAlpha,
  probeMediaDetails,
  probeMediaMetadata,
} from "./mediaMetadata.js";

afterEach(() => vi.unstubAllEnvs());

describe("classifyMediaColor", () => {
  it("detects HDR PQ from BT.2020 + smpte2084 metadata", () => {
    expect(
      classifyMediaColor({
        codec_type: "video",
        codec_name: "hevc",
        profile: "Main 10",
        pix_fmt: "yuv420p10le",
        color_space: "bt2020nc",
        color_transfer: "smpte2084",
        color_primaries: "bt2020",
      }),
    ).toMatchObject({
      dynamicRange: "hdr",
      hdrTransfer: "pq",
      label: "HDR PQ",
      isHdr: true,
    });
  });

  it("detects HDR HLG from arib-std-b67 metadata", () => {
    expect(
      classifyMediaColor({
        codec_type: "video",
        color_space: "bt2020nc",
        color_transfer: "arib-std-b67",
        color_primaries: "bt2020",
      }),
    ).toMatchObject({
      dynamicRange: "hdr",
      hdrTransfer: "hlg",
      label: "HDR HLG",
      isHdr: true,
    });
  });

  it("labels BT.709 media as SDR Rec.709", () => {
    expect(
      classifyMediaColor({
        codec_type: "video",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
      }),
    ).toMatchObject({
      dynamicRange: "sdr",
      hdrTransfer: null,
      label: "SDR Rec.709",
      isHdr: false,
    });
  });
});

describe("probeMediaMetadata", () => {
  it("reads the first video stream from ffprobe JSON", async () => {
    const metadata = await probeMediaMetadata("/tmp/clip.mp4", () => ({
      status: 0,
      stdout: JSON.stringify({
        streams: [
          { codec_type: "audio", codec_name: "aac" },
          {
            codec_type: "video",
            codec_name: "hevc",
            pix_fmt: "yuv420p10le",
            color_space: "bt2020nc",
            color_transfer: "smpte2084",
            color_primaries: "bt2020",
          },
        ],
      }),
      stderr: "",
    }));

    expect(metadata).toMatchObject({
      kind: "video",
      color: { isHdr: true, label: "HDR PQ" },
    });
  });

  it("reports whether a video carries an audio stream", async () => {
    const withAudio = await probeMediaMetadata("/tmp/clip.mp4", () => ({
      status: 0,
      stdout: JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "h264" },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }),
      stderr: "",
    }));
    expect(withAudio).toMatchObject({ kind: "video", hasAudio: true });

    const silent = await probeMediaMetadata("/tmp/silent.mp4", () => ({
      status: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264" }] }),
      stderr: "",
    }));
    expect(silent).toMatchObject({ kind: "video", hasAudio: false });

    // An audio file is not a video; the flag is a video question only.
    const audioFile = await probeMediaMetadata("/tmp/music.wav", () => ({
      status: 0,
      stdout: "{}",
      stderr: "",
    }));
    expect(audioFile).not.toHaveProperty("hasAudio");
  });

  it("reads a flac file as audio", async () => {
    const flac = await probeMediaMetadata("/tmp/music.flac", () => ({
      status: 0,
      stdout: "{}",
      stderr: "",
    }));
    expect(flac.kind).toBe("audio");
  });

  it("ignores attached cover art and reads the real video stream", async () => {
    const metadata = await probeMediaMetadata("/tmp/clip.mp4", () => ({
      status: 0,
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "mjpeg",
            pix_fmt: "yuvj420p",
            disposition: { attached_pic: 1 },
          },
          {
            codec_type: "video",
            codec_name: "hevc",
            pix_fmt: "yuv420p10le",
            disposition: { attached_pic: 0 },
          },
        ],
      }),
      stderr: "",
    }));

    expect(metadata).toMatchObject({
      kind: "video",
      color: { codecName: "hevc", pixelFormat: "yuv420p10le" },
    });
  });

  it("returns unknown metadata when ffprobe is unavailable", async () => {
    await expect(
      probeMediaMetadata("/tmp/clip.mp4", () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT" } as NodeJS.ErrnoException,
      })),
    ).resolves.toMatchObject({
      kind: "video",
      color: { dynamicRange: "unknown", isHdr: false },
      probeError: "ffprobe unavailable",
    });
  });

  it("supports an injected async runner without requiring local ffprobe", async () => {
    vi.stubEnv("HYPERFRAMES_FFPROBE_PATH", "/definitely/missing/ffprobe");
    const metadata = await probeMediaMetadata("/tmp/clip.mp4", async () => ({
      status: 0,
      stdout: JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" }],
      }),
      stderr: "",
    }));
    expect(metadata).toMatchObject({ kind: "video", color: { codecName: "h264" } });
  });
});

describe("pixelFormatHasAlpha", () => {
  it("detects alpha-bearing pixel formats", () => {
    for (const pixFmt of [
      "yuva420p",
      "yuva444p10le",
      "rgba",
      "argb",
      "bgra",
      "abgr",
      "gbrap12le",
      "ya8",
    ]) {
      expect(pixelFormatHasAlpha(pixFmt)).toBe(true);
    }
    for (const pixFmt of ["yuv420p", "yuv422p10le", "rgb24", "gbrp", "gray", undefined]) {
      expect(pixelFormatHasAlpha(pixFmt)).toBe(false);
    }
  });
});

describe("parseFrameRate", () => {
  it.each([
    ["30/1", 30],
    ["30000/1001", 29.97],
    ["24000/1001", 23.976],
    ["25", 25],
    ["0/0", undefined],
    ["30/0", undefined],
    [undefined, undefined],
  ])("reads %j as %j", (rate, fps) => {
    expect(parseFrameRate(rate)).toBe(fps);
  });
});

describe("media details", () => {
  const answer = (stdout: unknown) => () => ({
    status: 0,
    stdout: JSON.stringify(stdout),
    stderr: "",
  });

  it("reads a video's size, rate, length and soundtrack from the one probe", async () => {
    const metadata = await probeMediaDetails(
      "/tmp/clip.mp4",
      answer({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30000/1001",
          },
          { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
        ],
        format: { duration: "12.5" },
      }),
    );
    expect(metadata).toMatchObject({
      kind: "video",
      width: 1920,
      height: 1080,
      frameRate: 29.97,
      durationSeconds: 12.5,
      hasAudio: true,
      audio: { codecName: "aac", sampleRate: 48000, channels: 2 },
    });
    expect(metadata.color.codecName).toBe("h264");
  });

  it("says a silent video has no audio", async () => {
    const metadata = await probeMediaDetails(
      "/tmp/clip.webm",
      answer({
        streams: [
          { codec_type: "video", codec_name: "vp9", width: 640, height: 360, r_frame_rate: "25/1" },
        ],
      }),
    );
    expect(metadata).toMatchObject({ hasAudio: false, frameRate: 25 });
    expect(metadata.audio).toBeUndefined();
  });

  it("reads an image's size and no frame rate", async () => {
    const metadata = await probeMediaDetails(
      "/tmp/still.png",
      answer({
        streams: [
          {
            codec_type: "video",
            codec_name: "png",
            width: 800,
            height: 600,
            avg_frame_rate: "25/1",
          },
        ],
      }),
    );
    expect(metadata).toMatchObject({ kind: "image", width: 800, height: 600 });
    expect(metadata.frameRate).toBeUndefined();
  });

  it("probes an audio file for its codec and length, which the bulk probe skips", async () => {
    const runner = vi.fn(
      answer({
        streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 1 }],
        format: { duration: "3.2" },
      }),
    );
    expect(await probeMediaMetadata("/tmp/voice.mp3", runner)).toEqual({
      kind: "audio",
      color: expect.anything(),
    });
    expect(runner).not.toHaveBeenCalled();
    expect(await probeMediaDetails("/tmp/voice.mp3", runner)).toMatchObject({
      kind: "audio",
      durationSeconds: 3.2,
      audio: { codecName: "mp3", sampleRate: 44100, channels: 1 },
    });
  });

  it("reports a failed probe instead of guessing", async () => {
    expect(
      await probeMediaDetails("/tmp/voice.wav", () => ({ status: 1, stdout: "", stderr: "bad" })),
    ).toMatchObject({ kind: "audio", probeError: "ffprobe failed" });
  });
});

describe.skipIf(!findFfBinary("ffmpeg") || !findFfBinary("ffprobe"))(
  "media details of real files",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-media-details-"));
    const ffmpeg = (...args: string[]) => {
      const r = spawnSync(findFfBinary("ffmpeg") ?? "ffmpeg", ["-v", "error", "-y", ...args]);
      if (r.status !== 0) throw new Error(String(r.stderr));
    };
    beforeAll(() => {
      const picture = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1"];
      const tone = ["-f", "lavfi", "-i", "sine=duration=1:sample_rate=44100"];
      ffmpeg(
        ...picture,
        ...tone,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        join(dir, "talk.mp4"),
      );
      ffmpeg(...picture, "-pix_fmt", "yuv420p", join(dir, "silent.mp4"));
      ffmpeg(...tone, "-ac", "2", join(dir, "tone.wav"));
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=200x100",
        "-frames:v",
        "1",
        join(dir, "still.png"),
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("reads them", async () => {
      expect(await probeMediaDetails(join(dir, "talk.mp4"))).toMatchObject({
        kind: "video",
        width: 320,
        height: 180,
        frameRate: 24,
        hasAudio: true,
        audio: { codecName: "aac", sampleRate: 44100, channels: 1 },
        color: { codecName: "h264" },
      });
      expect(await probeMediaDetails(join(dir, "silent.mp4"))).toMatchObject({ hasAudio: false });
      expect(await probeMediaDetails(join(dir, "tone.wav"))).toMatchObject({
        kind: "audio",
        audio: { codecName: "pcm_s16le", sampleRate: 44100, channels: 2 },
        durationSeconds: 1,
      });
      expect(await probeMediaDetails(join(dir, "still.png"))).toMatchObject({
        kind: "image",
        width: 200,
        height: 100,
        color: { codecName: "png" },
      });
    });
  },
);
