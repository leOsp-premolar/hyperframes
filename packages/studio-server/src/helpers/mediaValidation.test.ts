import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import {
  STUDIO_IMPORT_EXTENSIONS,
  unsupportedImportReason,
  validateUploadedMedia,
  validateUploadedMediaBuffer,
} from "./mediaValidation.js";

describe("validateUploadedMedia", () => {
  it("passes through non-media files", () => {
    expect(
      validateUploadedMedia("/tmp/test.txt", () => ({ status: 0, stdout: "", stderr: "" })),
    ).toEqual({
      ok: true,
    });
  });

  it("accepts video files with a video stream", () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
      stderr: "",
    }));

    expect(validateUploadedMedia("/tmp/test.mp4", runner)).toEqual({ ok: true });
    expect(runner).toHaveBeenCalledWith(
      expect.stringMatching(/ffprobe/),
      expect.any(Array),
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("rejects video files with no supported video stream", () => {
    expect(
      validateUploadedMedia("/tmp/test.mp4", () => ({
        status: 0,
        stdout: JSON.stringify({ streams: [] }),
        stderr: "",
      })),
    ).toEqual({ ok: false, reason: "no supported video stream found" });
  });

  it.each(["/tmp/test.flac", "/tmp/test.m4v"])(
    "probes %s instead of passing it through",
    (path) => {
      expect(
        validateUploadedMedia(path, () => ({
          status: 0,
          stdout: JSON.stringify({ streams: [] }),
          stderr: "",
        })),
      ).toMatchObject({ ok: false });
    },
  );

  it("accepts audio files with an audio stream", () => {
    expect(
      validateUploadedMedia("/tmp/test.wav", () => ({
        status: 0,
        stdout: JSON.stringify({ streams: [{ codec_type: "audio" }] }),
        stderr: "",
      })),
    ).toEqual({ ok: true });
  });

  it("accepts the upload but says it was not checked when ffprobe is unavailable", () => {
    expect(
      validateUploadedMedia("/tmp/test.mp4", () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT" } as NodeJS.ErrnoException,
      })),
    ).toEqual({ ok: true, unchecked: expect.stringMatching(/ffprobe was not found/) });
  });

  describe("with HYPERFRAMES_FFPROBE_PATH", () => {
    const configured = process.env.HYPERFRAMES_FFPROBE_PATH;
    const dir = mkdtempSync(join(tmpdir(), "hf-ffprobe-path-"));
    afterEach(() => {
      if (configured === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH;
      else process.env.HYPERFRAMES_FFPROBE_PATH = configured;
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("runs the ffprobe it names", () => {
      const ffprobe = join(dir, "ffprobe");
      writeFileSync(ffprobe, "");
      process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
      const runner = vi.fn(() => ({
        status: 0,
        stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
        stderr: "",
      }));

      expect(validateUploadedMedia("/tmp/test.mp4", runner)).toEqual({ ok: true });
      expect(runner).toHaveBeenCalledWith(ffprobe, expect.any(Array), expect.anything());
    });

    it("rejects the upload, naming the setting, when the ffprobe it names cannot run", () => {
      const missing = join(dir, "missing-ffprobe");
      process.env.HYPERFRAMES_FFPROBE_PATH = missing;

      expect(validateUploadedMedia("/tmp/test.mp4")).toEqual({
        ok: false,
        reason: expect.stringContaining(`HYPERFRAMES_FFPROBE_PATH names "${missing}"`),
      });
    });
  });
});

describe("validateUploadedMediaBuffer", () => {
  it("validates media from a temp file that preserves the extension", () => {
    let inspectedPath = "";
    expect(
      validateUploadedMediaBuffer("raycast.mp4", new Uint8Array([0, 1, 2]), (_command, args) => {
        inspectedPath = args.at(-1) ?? "";
        return {
          status: 0,
          stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
          stderr: "",
        };
      }),
    ).toEqual({ ok: true });

    expect(inspectedPath).toMatch(/raycast\.mp4$/);
  });
});

describe("images", () => {
  const sized = JSON.stringify({ streams: [{ codec_type: "video", width: 64, height: 48 }] });
  // What ffprobe reports for a PNG with a broken signature or a truncated chunk.
  const sizeless = JSON.stringify({ streams: [{ codec_type: "video", width: 0, height: 0 }] });

  it("accepts an image whose frame has a size", () => {
    expect(
      validateUploadedMedia("/tmp/a.png", () => ({ status: 0, stdout: sized, stderr: "" })),
    ).toEqual({ ok: true });
  });

  it("rejects an image ffprobe lists without a size, as damaged", () => {
    expect(
      validateUploadedMedia("/tmp/a.png", () => ({ status: 0, stdout: sizeless, stderr: "" })),
    ).toEqual({ ok: false, reason: "could not be read: the file is damaged or is not really PNG" });
  });

  it("accepts an AVIF this FFmpeg cannot decode, saying it was not checked", () => {
    expect(
      validateUploadedMedia("/tmp/a.avif", () => ({ status: 1, stdout: "", stderr: "no decoder" })),
    ).toEqual({ ok: true, unchecked: expect.stringMatching(/cannot decode AVIF/) });
  });

  it("checks an SVG by its content, without ffprobe", () => {
    const runner = vi.fn(() => ({ status: 0, stdout: sized, stderr: "" }));
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    expect(validateUploadedMediaBuffer("logo.svg", svg, runner)).toEqual({ ok: true });
    expect(
      validateUploadedMediaBuffer("logo.svg", new TextEncoder().encode("hello"), runner),
    ).toEqual({
      ok: false,
      reason: "could not be read: the file is damaged or is not really SVG",
    });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("unsupportedImportReason", () => {
  it.each(["clip.mp4", "CLIP.MOV", "a.webm", "b.m4v", "p.PNG", "s.svg", "v.wav", "f.woff2"])(
    "lets %s through",
    (name) => expect(unsupportedImportReason(name)).toBeNull(),
  );

  it.each([
    ["notes.txt", ".txt files can't be imported"],
    ["movie.mkv", ".mkv files can't be imported"],
    ["archive.zip", ".zip files can't be imported"],
    ["README", "Files without an extension can't be imported"],
  ])("refuses %s", (name, start) => {
    expect(unsupportedImportReason(name)).toMatch(new RegExp(`^${start.replace(".", "\\.")}`));
    expect(unsupportedImportReason(name)).toContain("MP4, WebM, MOV or M4V");
  });

  it("matches the formats Studio lists in the Assets panel", () => {
    // packages/studio/src/utils/mediaTypes.ts, compared both ways so neither list drifts.
    const studio = readFileSync(
      join(import.meta.dirname, "../../../studio/src/utils/mediaTypes.ts"),
      "utf8",
    );
    const list = (name: string) =>
      JSON.parse(studio.match(new RegExp(`${name} = (\\[[^\\]]*\\])`))?.[1] ?? "null");
    expect(list("VIDEO_EXTS")).toEqual(STUDIO_IMPORT_EXTENSIONS.video);
    expect(list("IMAGE_EXTS")).toEqual(STUDIO_IMPORT_EXTENSIONS.image);
    expect(list("AUDIO_EXTS")).toEqual(STUDIO_IMPORT_EXTENSIONS.audio);
    const fonts = studio.match(/FONT_EXT = \/\\\.\(([^)]*)\)/)?.[1]?.split("|");
    expect(fonts).toEqual(STUDIO_IMPORT_EXTENSIONS.font);
  });
});

describe.skipIf(!findFfBinary("ffmpeg") || !findFfBinary("ffprobe"))("with real files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-media-validation-"));
  const ffmpeg = (...args: string[]) => {
    const r = spawnSync(findFfBinary("ffmpeg") ?? "ffmpeg", ["-v", "error", "-y", ...args]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  };
  const file = (name: string) => readFileSync(join(dir, name));

  beforeAll(() => {
    const frame = ["-f", "lavfi", "-i", "testsrc2=size=64x48", "-frames:v", "1"];
    for (const ext of ["png", "jpg", "webp", "gif"]) ffmpeg(...frame, join(dir, `ok.${ext}`));
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x48:duration=0.5",
      "-pix_fmt",
      "yuv420p",
      join(dir, "ok.mp4"),
    );
    ffmpeg("-f", "lavfi", "-i", "sine=duration=0.5", join(dir, "ok.wav"));
    writeFileSync(join(dir, "truncated.png"), file("ok.png").subarray(0, 100));
    writeFileSync(join(dir, "noise.png"), Buffer.alloc(2000, 0x5a));
    writeFileSync(join(dir, "noise.mp4"), Buffer.alloc(4000, 0x5a));
    writeFileSync(join(dir, "truncated.mp4"), file("ok.mp4").subarray(0, 200));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(["ok.png", "ok.jpg", "ok.webp", "ok.gif", "ok.mp4", "ok.wav"])("accepts %s", (name) => {
    expect(validateUploadedMediaBuffer(name, file(name))).toEqual({ ok: true });
  });

  it.each(["truncated.png", "noise.png", "noise.mp4", "truncated.mp4"])("rejects %s", (name) => {
    expect(validateUploadedMediaBuffer(name, file(name))).toMatchObject({ ok: false });
  });

  it("rejects a sound file named as a video", () => {
    expect(validateUploadedMediaBuffer("sound.mp4", file("ok.wav"))).toEqual({
      ok: false,
      reason: "no supported video stream found",
    });
  });
});
