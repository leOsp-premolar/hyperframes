import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "citty";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertKnownFlags } from "../utils/reject-unknown-flags.js";
import { VoiceError } from "../voice/types.js";

const synthesizeMock = vi.fn().mockResolvedValue({
  durationSeconds: 1,
  langApplied: true,
  outputPath: "/tmp/speech.wav",
});
vi.mock("../tts/synthesize.js", () => ({ synthesize: synthesizeMock }));

const synthesizeSpeechMock = vi.fn();
const listVoicesMock = vi.fn();
vi.mock("../api/voice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/voice.js")>()),
  synthesizeSpeech: synthesizeSpeechMock,
  listVoices: listVoicesMock,
}));

import ttsCommand from "./tts.js";

describe("tts --provider", () => {
  let dir: string;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-tts-voice-test-"));
    logs = [];
    synthesizeMock.mockClear();
    synthesizeSpeechMock.mockReset();
    listVoicesMock.mockReset();
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("speaks through the voice API and saves the word timings", async () => {
    const output = join(dir, "line.mp3");
    const wordsPath = join(dir, "words.json");
    synthesizeSpeechMock.mockResolvedValue({
      provider: "openai",
      voice: "coral",
      model: "gpt-4o-mini-tts",
      outputPath: output,
      durationSeconds: 1.8,
      speed: 0.9,
      styleApplied: true,
      words: [{ text: "Hola", start: 0.1, end: 0.5 }],
      wordsSource: "transcription",
    });
    const flags = [
      "Hola",
      "--provider",
      "openai",
      "--voice",
      "coral",
      "--style",
      "tierna",
      "--speed",
      "0.9",
      "--lang",
      "es",
      "--words",
      wordsPath,
      "-o",
      output,
      "--json",
    ];
    expect(() => assertKnownFlags(ttsCommand as never, flags)).not.toThrow();
    await runCommand(ttsCommand, { rawArgs: flags });

    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).toHaveBeenCalledWith({
      text: "Hola",
      outputPath: output,
      provider: "openai",
      voice: "coral",
      model: undefined,
      speed: 0.9,
      style: "tierna",
      language: "es",
      words: true,
    });
    expect(JSON.parse(readFileSync(wordsPath, "utf8"))).toEqual([
      { id: "w0", text: "Hola", start: 0.1, end: 0.5 },
    ]);
    expect(JSON.parse(logs.at(-1) ?? "")).toMatchObject({
      ok: true,
      provider: "openai",
      wordsPath,
      wordsSource: "transcription",
    });
  });

  it("keeps plain Kokoro on its own path", async () => {
    await runCommand(ttsCommand, { rawArgs: ["Hello", "--json"] });
    expect(synthesizeMock).toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("sends Kokoro through the voice API when asked for word timings", async () => {
    synthesizeSpeechMock.mockResolvedValue({
      provider: "kokoro",
      voice: "af_heart",
      model: "kokoro-v1.0",
      outputPath: "/tmp/speech.wav",
      durationSeconds: 1,
      speed: 1,
      styleApplied: false,
      words: [],
      wordsSource: "transcription",
    });
    await runCommand(ttsCommand, {
      rawArgs: ["Hello", "--words", join(dir, "w.json"), "--json"],
    });
    expect(synthesizeSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kokoro", words: true }),
    );
  });

  it("rejects an unknown provider before speaking", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runCommand(ttsCommand, { rawArgs: ["Hola", "--provider", "azure"] }),
    ).rejects.toThrow();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).toContain("Unknown --provider");
  });

  it("reports the voice API's error code in JSON", async () => {
    synthesizeSpeechMock.mockRejectedValue(
      new VoiceError("not_configured", "OpenAI is not set up. Set OPENAI_API_KEY."),
    );
    await expect(
      runCommand(ttsCommand, { rawArgs: ["Hola", "--provider", "openai", "--json"] }),
    ).rejects.toThrow();
    expect(JSON.parse(logs.at(-1) ?? "")).toEqual({
      ok: false,
      code: "not_configured",
      error: "OpenAI is not set up. Set OPENAI_API_KEY.",
    });
  });

  it("lists a provider's voices", async () => {
    listVoicesMock.mockResolvedValue([{ id: "v1", name: "Sofía" }]);
    await runCommand(ttsCommand, { rawArgs: ["--list", "--provider", "elevenlabs", "--json"] });
    expect(listVoicesMock).toHaveBeenCalledWith("elevenlabs");
    expect(JSON.parse(logs.at(-1) ?? "")).toEqual([{ id: "v1", name: "Sofía" }]);
  });
});
