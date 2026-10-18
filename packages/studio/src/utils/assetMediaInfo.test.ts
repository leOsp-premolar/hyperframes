import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codecLabel,
  describeAssetMedia,
  fetchAssetMediaInfo,
  parseAssetMediaInfo,
  resetAssetMediaInfoCache,
} from "./assetMediaInfo";

const video = {
  metadata: {
    kind: "video",
    color: { codecName: "h264" },
    width: 1920,
    height: 1080,
    frameRate: 29.97,
    hasAudio: true,
    audio: { codecName: "aac", sampleRate: 48000, channels: 2 },
  },
};

describe("parseAssetMediaInfo", () => {
  it("reads what the metadata endpoint answers", () => {
    expect(parseAssetMediaInfo(video)).toEqual({
      kind: "video",
      width: 1920,
      height: 1080,
      frameRate: 29.97,
      codec: "h264",
      hasAudio: true,
      audioCodec: "aac",
      sampleRate: 48000,
      channels: 2,
    });
  });

  it.each([
    ["no body", null],
    ["no metadata", {}],
    ["an unknown kind", { metadata: { kind: "font" } }],
    ["a failed probe", { metadata: { kind: "video", probeError: "ffprobe failed" } }],
  ])("has nothing to show for %s", (_case, body) => {
    expect(parseAssetMediaInfo(body)).toBeNull();
  });

  it("drops values that are not real measurements", () => {
    const info = parseAssetMediaInfo({ metadata: { kind: "video", width: 0, frameRate: "30" } });
    expect(info).toMatchObject({ kind: "video" });
    expect(info?.width).toBeUndefined();
    expect(info?.frameRate).toBeUndefined();
  });
});

describe("describeAssetMedia", () => {
  it("lists a video's size, rate, codec and sound", () => {
    const info = parseAssetMediaInfo(video);
    expect(info && describeAssetMedia(info)).toEqual(["1920×1080", "29.97 fps", "H.264", "AAC"]);
  });

  it("says when a video has no audio, and keeps whole frame rates whole", () => {
    expect(
      describeAssetMedia({
        kind: "video",
        width: 640,
        height: 360,
        frameRate: 30,
        codec: "vp9",
        hasAudio: false,
      }),
    ).toEqual(["640×360", "30 fps", "VP9", "No audio"]);
  });

  it("lists an image's size and format", () => {
    expect(describeAssetMedia({ kind: "image", width: 800, height: 600, codec: "png" })).toEqual([
      "800×600",
      "PNG",
    ]);
  });

  it("lists an audio file's codec, rate and channels", () => {
    expect(
      describeAssetMedia({
        kind: "audio",
        audioCodec: "pcm_s16le",
        sampleRate: 44100,
        channels: 1,
      }),
    ).toEqual(["PCM", "44.1 kHz", "Mono"]);
  });

  it("shows nothing it does not know", () => {
    expect(describeAssetMedia({ kind: "video" })).toEqual([]);
  });

  it.each([
    ["h264", "H.264"],
    ["hevc", "HEVC"],
    ["prores", "ProRes"],
    ["pcm_f32le", "PCM"],
    ["dnxhd", "DNXHD"],
  ])("names %s %s", (codec, label) => {
    expect(codecLabel(codec)).toBe(label);
  });
});

describe("fetchAssetMediaInfo", () => {
  beforeEach(() => resetAssetMediaInfoCache());
  afterEach(() => vi.unstubAllGlobals());

  it("probes each file once per session", async () => {
    const fetchMock = vi.fn(async () => Response.json(video));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAssetMediaInfo("p", "clip.mp4");
    await fetchAssetMediaInfo("p", "clip.mp4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/projects/p/media/metadata?path=clip.mp4",
    );
  });

  it("forgets a failed probe so the next card can try again", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(Response.json(video));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAssetMediaInfo("p", "clip.mp4")).toBeNull();
    expect(await fetchAssetMediaInfo("p", "clip.mp4")).toMatchObject({ width: 1920 });
  });

  it("runs at most three probes at once", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return Response.json(video);
      }),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => fetchAssetMediaInfo("p", `clip-${i}.mp4`)),
    );
    expect(peak).toBe(3);
  });
});
