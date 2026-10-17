import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OPENAI_TTS_DEFAULT_VOICE,
  OPENAI_TTS_MAX_CHARS,
  OPENAI_TTS_MODEL,
  openaiConfigured,
  synthesizeOpenAI,
} from "./openai-tts.mjs";

const ENV = { OPENAI_API_KEY: "sk-test" };

function capture(status = 200, body = Buffer.from("RIFFfakewav")) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, json: JSON.parse(init.body) });
    return new Response(body, { status });
  };
  return { calls, fetchImpl };
}

test("synthesizeOpenAI posts the line with defaults and writes the audio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openai-tts-"));
  try {
    const wavAbs = join(dir, "assets", "voice", "line-0.mp3");
    const { calls, fetchImpl } = capture();
    const res = await synthesizeOpenAI(
      { text: "Hola mundo", voiceId: null, model: null, wavAbs },
      { fetchImpl, env: ENV },
    );
    assert.deepEqual(res, { ok: true, words: null });
    assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(calls[0].json, {
      model: OPENAI_TTS_MODEL,
      input: "Hola mundo",
      voice: OPENAI_TTS_DEFAULT_VOICE,
      response_format: "wav",
      speed: 1,
    });
    assert.equal(readFileSync(wavAbs, "utf8"), "RIFFfakewav");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeOpenAI hands .wav output to the transcoder", async () => {
  const seen = [];
  const { fetchImpl } = capture();
  const res = await synthesizeOpenAI(
    { text: "hi", wavAbs: "/nowhere/x.wav" },
    { fetchImpl, env: ENV, transcode: (bytes, dest) => seen.push([bytes.length, dest]) > 0 },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [[11, "/nowhere/x.wav"]]);
});

test("synthesizeOpenAI sends style as instructions only to gpt-4o models", async () => {
  const a = capture();
  await synthesizeOpenAI(
    { text: "hi", style: "warm, slow", wavAbs: "/tmp/x.wav" },
    { fetchImpl: a.fetchImpl, env: ENV, transcode: () => true },
  );
  assert.equal(a.calls[0].json.instructions, "warm, slow");
  const b = capture();
  await synthesizeOpenAI(
    { text: "hi", style: "warm", model: "tts-1", wavAbs: "/tmp/x.wav" },
    { fetchImpl: b.fetchImpl, env: ENV, transcode: () => true },
  );
  assert.equal("instructions" in b.calls[0].json, false);
});

test("synthesizeOpenAI reports failures instead of throwing", async () => {
  const noKey = await synthesizeOpenAI({ text: "hi", wavAbs: "/tmp/x.wav" }, { env: {} });
  assert.match(noKey.error, /OPENAI_API_KEY is not set/);

  const http = capture(401, '{"error":{"message":"bad key"}}');
  const denied = await synthesizeOpenAI(
    { text: "hi", wavAbs: "/tmp/x.wav" },
    { fetchImpl: http.fetchImpl, env: ENV },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /HTTP 401: .*bad key/);

  const long = await synthesizeOpenAI(
    { text: "a".repeat(OPENAI_TTS_MAX_CHARS + 1), wavAbs: "/tmp/x.wav" },
    { env: ENV },
  );
  assert.match(long.error, /accepts up to 4096/);

  const model = await synthesizeOpenAI(
    { text: "hi", model: "eleven_multilingual_v2", wavAbs: "/tmp/x.wav" },
    { env: ENV },
  );
  assert.match(model.error, /Unsupported OpenAI TTS model/);

  const fail = await synthesizeOpenAI(
    { text: "hi", wavAbs: "/tmp/never.wav" },
    { fetchImpl: capture().fetchImpl, env: ENV, transcode: () => false },
  );
  assert.match(fail.error, /transcode failed/);
  assert.equal(existsSync("/tmp/never.wav"), false);
});

test("openaiConfigured ignores a blank key", () => {
  assert.equal(openaiConfigured({ OPENAI_API_KEY: "  " }), false);
  assert.equal(openaiConfigured(ENV), true);
});
