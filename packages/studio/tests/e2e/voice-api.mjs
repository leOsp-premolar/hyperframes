#!/usr/bin/env node
// The voice API through the real UI, against a stand-in for ElevenLabs this gate serves itself:
// Studio lists the providers and the account's voices, speaks a line into assets/voice as 44.1 kHz
// mono WAV with the chosen voice and speed, keeps a second take of the same words beside the first
// (slowed past what ElevenLabs does natively, so ffmpeg stretches it), shows a refusal as the
// provider worded it without writing anything, and the new voice can be placed on the timeline.
//
//   ELEVENLABS_BASE_URL=http://127.0.0.1:5399 ELEVENLABS_API_KEY=hf-gate-key \
//     bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/voice-api" node tests/e2e/voice-api.mjs
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check,
  clickLeafText,
  dropOnEmptyTimeline,
  ffmpeg,
  runStudioGate,
  studioGateSetup,
  watchPageErrors,
} from "./editorWorkflowSteps.mjs";

const PROJECT_ID = "voice-api";
const STUDIO_URL = process.env.STUDIO_URL;
const MOCK_PORT = Number(process.env.VOICE_MOCK_PORT ?? 5399);
const KEY = "hf-gate-key";
const SECONDS_PER_CHAR = 0.05;
const LINE = "Con la primera luz de la mañana, una pequeña semilla despertó.";
const SPOKEN_S = round2([...LINE].length * SECONDS_PER_CHAR);
const FIRST_PATH = "assets/voice/con-la-primera-luz-de-la.wav";
const SECOND_PATH = "assets/voice/con-la-primera-luz-de-la-2.wav";

const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);
const origin = STUDIO_URL ? new URL(STUDIO_URL).origin : "";
const mockDir = mkdtempSync(join(tmpdir(), "hf-voice-mock-"));
const received = [];

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── the ElevenLabs stand-in ────────────────────────────────────────────────────
function speechFor(text) {
  const characters = [...text];
  const seconds = Math.max(0.6, characters.length * SECONDS_PER_CHAR);
  const out = join(mockDir, `speech-${received.length}.mp3`);
  ffmpeg("-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`, "-ar", "44100", out);
  const step = seconds / characters.length;
  return {
    audio_base64: readFileSync(out).toString("base64"),
    alignment: {
      characters,
      character_start_times_seconds: characters.map((_, i) => i * step),
      character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
    },
  };
}

const VOICES = [
  { voice_id: "mock-sofia", name: "Sofía", labels: { gender: "female", accent: "latin american" } },
  { voice_id: "mock-mateo", name: "Mateo", labels: { gender: "male", accent: "castilian" } },
];

const SPEAK = /^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/;

function speakAnswer(voice, query, raw) {
  const body = JSON.parse(raw || "{}");
  received.push({ voice: decodeURIComponent(voice), query, body });
  const text = String(body.text);
  return text.includes("quota")
    ? [429, { detail: { message: "You have reached your character quota" } }]
    : [200, speechFor(text)];
}

/** [status, body] for one request, as ElevenLabs would answer it. */
function answer(req, raw) {
  if (req.headers["xi-api-key"] !== KEY) {
    return [401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }];
  }
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  const speak = url.pathname.match(SPEAK);
  if (speak) return speakAnswer(speak[1], url.search, raw);
  return url.pathname === "/v1/voices" ? [200, { voices: VOICES }] : [404, { detail: "not found" }];
}

const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const [status, body] = answer(req, raw);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

function probe(file) {
  if (!existsSync(file)) return null;
  const entries = "stream=codec_name,sample_rate,channels:format=duration";
  const args = ["-v", "error", "-show_entries", entries, "-of", "json", file];
  const { streams, format } = JSON.parse(spawnSync("ffprobe", args, { encoding: "utf8" }).stdout);
  const [stream] = streams;
  return {
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    duration: round2(Number(format.duration)),
  };
}

function isMonoWav(file) {
  return file?.codec === "pcm_s16le" && file.sampleRate === 44100 && file.channels === 1;
}

// ── the UI ─────────────────────────────────────────────────────────────────────
const clickButton = (page, scope, label) =>
  page.evaluate(
    (s, l) =>
      [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim() === l).click(),
    scope,
    label,
  );

async function openVoiceDialog(page) {
  await clickLeafText(page, "Assets");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Generate voice",
      ),
    { timeout: 30_000 },
  );
  await clickButton(page, "body", "Generate voice");
  await page.waitForSelector('[role="dialog"] #voice-text', { timeout: 10_000 });
  // The provider list, then the voices of the provider it resolves to.
  await page.waitForFunction(() => document.querySelectorAll("#voice-voice option").length > 1, {
    timeout: 20_000,
  });
}

function dialogState(page) {
  return page.evaluate(() => ({
    providers: [...document.querySelectorAll("#voice-provider option")].map((o) => o.textContent),
    voices: [...document.querySelectorAll("#voice-voice option")].map((o) => o.value),
    alert: document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? null,
  }));
}

async function fill(page, selector, value) {
  await page.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v);
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    },
    selector,
    value,
  );
}

async function speak(page, { text, voice = "", speed }) {
  await fill(page, "#voice-text", text);
  await fill(page, "#voice-voice", voice);
  await fill(page, "#voice-speed", String(speed));
  await fill(page, "#voice-language", "es");
  await clickButton(page, '[role="dialog"]', "Generate voice");
}

function waitForText(page, text) {
  return page
    .waitForFunction(
      (t) =>
        [...document.querySelectorAll("*")].find(
          (e) => e.children.length === 0 && e.textContent.includes(t),
        )?.textContent,
      { timeout: 60_000 },
      text,
    )
    .then((h) => h.jsonValue());
}

async function waitForSavedAudio(src) {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
    const html = readFileSync(join(projectDir, "index.html"), "utf8");
    const tag = html.match(/<audio\b[^>]*>/g)?.find((t) => t.includes(src));
    if (tag) return tag;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// ── the steps ──────────────────────────────────────────────────────────────────
async function providersAreListed({ evidence, failures }) {
  const providers = await (await fetch(`${origin}/api/voice/providers`)).json();
  evidence.providers = providers.providers.map((p) => `${p.id}:${p.configured}`);
  if (providers.auto !== "elevenlabs") {
    throw new Error(
      `Studio does not see the ElevenLabs stand-in (auto is ${providers.auto}); start it with ELEVENLABS_BASE_URL=http://127.0.0.1:${MOCK_PORT} ELEVENLABS_API_KEY=${KEY}`,
    );
  }
  check(failures, !JSON.stringify(providers).includes(KEY), "the provider list leaks the API key");
}

// 1. The dialog offers the stand-in's voices for "Best available".
async function dialogOffersVoices({ page, shot, evidence, failures }) {
  await openVoiceDialog(page);
  evidence.dialog = await dialogState(page);
  const [auto] = evidence.dialog.providers;
  check(
    failures,
    auto === "Best available (ElevenLabs)",
    `the first provider option reads ${auto}`,
  );
  const voices = JSON.stringify(evidence.dialog.voices);
  check(failures, voices === '["","mock-sofia","mock-mateo"]', `the voice list is ${voices}`);
  await shot("1-dialog");
}

// 2. A line in Sofía's voice at 0.9×, which ElevenLabs speaks natively.
async function firstTake({ page, shot, evidence, failures }) {
  await speak(page, { text: LINE, voice: "mock-sofia", speed: 0.9 });
  evidence.firstToast = await waitForText(page, `Voice saved: ${FIRST_PATH}`);
  const sent = received.at(-1);
  evidence.firstRequest = sent;
  check(failures, sent.voice === "mock-sofia", `ElevenLabs was asked for voice ${sent.voice}`);
  check(failures, sent.query === "?output_format=mp3_44100_128", `query ${sent.query}`);
  check(failures, sent.body.model_id === "eleven_multilingual_v2", `model ${sent.body.model_id}`);
  check(failures, sent.body.voice_settings?.speed === 0.9, "0.9× was not sent natively");
  check(failures, sent.body.text === LINE, "the text that reached ElevenLabs changed");
  const file = probe(join(projectDir, FIRST_PATH));
  evidence.firstFile = file;
  check(failures, isMonoWav(file), `the first take is ${JSON.stringify(file)}`);
  const length = file?.duration ?? 0;
  check(
    failures,
    Math.abs(length - SPOKEN_S) < 0.15,
    `the first take lasts ${length}s, not ${SPOKEN_S}s`,
  );
  await page.waitForSelector(`[draggable="true"][data-asset-path="${FIRST_PATH}"]`, {
    timeout: 20_000,
  });
  await shot("2-first-take");
}

// 3. The same words again at 0.6×: a second file, stretched by ffmpeg, no native speed sent.
async function secondTake({ page, evidence, failures }) {
  await openVoiceDialog(page);
  await speak(page, { text: LINE, speed: 0.6 });
  evidence.secondToast = await waitForText(page, `Voice saved: ${SECOND_PATH}`);
  const settings = received.at(-1).body.voice_settings;
  check(failures, settings === undefined, "0.6× was sent to ElevenLabs");
  const file = probe(join(projectDir, SECOND_PATH));
  evidence.secondFile = file;
  const length = file?.duration ?? 0;
  const slowed = round2(SPOKEN_S / 0.6);
  check(
    failures,
    Math.abs(length - slowed) < 0.2,
    `the 0.6× take lasts ${length}s, not ${slowed}s`,
  );
  check(failures, existsSync(join(projectDir, FIRST_PATH)), "the second take replaced the first");
}

// 4. A refusal reads as ElevenLabs worded it, the dialog stays open and nothing is written.
async function refusalWritesNothing({ page, shot, evidence, failures }) {
  const voiceDir = join(projectDir, "assets/voice");
  const before = JSON.stringify(readdirSync(voiceDir).sort());
  await openVoiceDialog(page);
  await speak(page, { text: "Esto supera la quota", speed: 1 });
  await page.waitForSelector('[role="dialog"] [role="alert"]', { timeout: 30_000 });
  evidence.refusal = (await dialogState(page)).alert;
  const expected = "ElevenLabs answered 429: You have reached your character quota";
  check(failures, evidence.refusal === expected, `the refusal reads ${evidence.refusal}`);
  const after = JSON.stringify(readdirSync(voiceDir).sort());
  check(failures, after === before, `the refusal left ${after}`);
  await shot("3-refused");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] #voice-text'), {
    timeout: 10_000,
  });
}

// 5. The first take goes on the timeline like any imported audio.
async function placeFirstTake({ page, shot, evidence, failures }) {
  await dropOnEmptyTimeline(page, `[draggable="true"][data-asset-path="${FIRST_PATH}"]`);
  evidence.placed = await waitForSavedAudio(FIRST_PATH);
  check(failures, Boolean(evidence.placed), "the voice was not placed in index.html");
  await page.waitForFunction(() => document.querySelectorAll(".timeline-clip").length === 1, {
    timeout: 20_000,
  });
  await shot("4-placed");
}

await new Promise((resolve, reject) =>
  mock.listen(MOCK_PORT, "127.0.0.1", resolve).on("error", reject),
);

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const pageErrors = watchPageErrors(gate.page);
  try {
    for (const step of [
      providersAreListed,
      dialogOffersVoices,
      firstTake,
      secondTake,
      refusalWritesNothing,
      placeFirstTake,
    ]) {
      await step(gate);
    }
  } finally {
    gate.evidence.pageErrors = pageErrors;
    check(gate.failures, pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
    mock.close();
    rmSync(mockDir, { recursive: true, force: true });
  }
});
