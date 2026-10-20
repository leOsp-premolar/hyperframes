import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFFmpeg } from "../browser/ffmpeg.js";
import { writeSpeechFile } from "./audioFile.js";

const ffmpeg = findFFmpeg();

describe.skipIf(!ffmpeg)("writeSpeechFile", () => {
  let dir = "";
  let mp3 = new Uint8Array();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-voice-file-test-"));
    const source = join(dir, "source.mp3");
    execFileSync(ffmpeg ?? "ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=1",
      "-ar",
      "24000",
      source,
    ]);
    mp3 = readFileSync(source);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const signal = () => new AbortController().signal;

  it("writes 44.1 kHz mono wav in a folder it creates, with nothing left beside it", async () => {
    const out = join(dir, "voice", "line.wav");
    const seconds = await writeSpeechFile(mp3, out, { tempo: 1, signal: signal() });
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThan(1.15);
    const header = readFileSync(out).subarray(0, 4).toString();
    expect(header).toBe("RIFF");
    expect(readdirSync(join(dir, "voice"))).toEqual(["line.wav"]);
  });

  it("slows the speech down without losing any of it", async () => {
    const seconds = await writeSpeechFile(mp3, join(dir, "slow.wav"), {
      tempo: 0.5,
      signal: signal(),
    });
    expect(seconds).toBeGreaterThan(1.9);
    expect(seconds).toBeLessThan(2.2);
  });

  it("writes mp3 when asked", async () => {
    const out = join(dir, "line.mp3");
    const seconds = await writeSpeechFile(mp3, out, { tempo: 1, signal: signal() });
    expect(seconds).toBeGreaterThan(0.9);
    expect(existsSync(out)).toBe(true);
  });

  it("refuses other formats", async () => {
    await expect(
      writeSpeechFile(mp3, join(dir, "line.ogg"), { tempo: 1, signal: signal() }),
    ).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("leaves no file when the audio cannot be read", async () => {
    const out = join(dir, "broken", "line.wav");
    await expect(
      writeSpeechFile(new TextEncoder().encode("not audio"), out, { tempo: 1, signal: signal() }),
    ).rejects.toMatchObject({ code: "encode_failed" });
    expect(readdirSync(join(dir, "broken"))).toEqual([]);
  });
});
