#!/usr/bin/env node
// Media import through the real Assets file picker: good files are added with their facts on the
// card (size, frame rate, codec, sound), damaged and unsupported ones are refused by name with a
// reason, and nothing of a refused file reaches the project folder.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/editor-workflow" node tests/e2e/media-import.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  check,
  clickLeafText,
  ffmpeg,
  runStudioGate,
  studioGateSetup,
} from "./editorWorkflowSteps.mjs";

const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, "editor-workflow");
// Studio's own dot folders (history, waveform cache) come and go; the user's files are the rest.
const visibleFiles = () =>
  readdirSync(projectDir)
    .filter((f) => !f.startsWith("."))
    .sort();
const startFiles = visibleFiles();

// The facts each card must show; clip.mp4 is the gate's own 640x360, 30 fps clip with a tone.
const EXPECTED_FACTS = {
  "clip.mp4": "640×360 · 30 fps · H.264 · AAC",
  "silent.mp4": "320×180 · 24 fps · H.264 · No audio",
  "still.png": "200×100 · PNG",
  "tone.wav": "PCM · 48 kHz · Mono",
};
const REFUSED = ["broken.png", "broken.mp4", "notes.txt"];

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const { page, sourcePath, shot, evidence, failures } = gate;
  const workDir = mkdtempSync(join(tmpdir(), "hf-media-import-"));
  try {
    const files = [sourcePath, ...makeMedia(workDir)];
    await clickLeafText(page, "Assets");
    const input = await page.waitForSelector('input[type="file"]', { timeout: 10_000 });
    await input.uploadFile(...files);

    // 1. One message names every refused file and why.
    const toast = await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="alert"], [role="status"]')]
          .map((el) => el.textContent ?? "")
          .find((text) => text.includes("Not added:")),
      { timeout: 30_000 },
    );
    evidence.refusedMessage = await toast.jsonValue();
    for (const name of REFUSED) {
      check(
        failures,
        evidence.refusedMessage.includes(`${name} (`),
        `the message does not name ${name}`,
      );
    }
    check(
      failures,
      /damaged/.test(evidence.refusedMessage),
      "the message does not say why a file is damaged",
    );
    check(
      failures,
      /\.txt files can't be imported/.test(evidence.refusedMessage),
      "the message does not say why .txt is refused",
    );

    // 2. The project holds the good files and nothing of the refused ones, at any depth.
    const added = Object.keys(EXPECTED_FACTS);
    evidence.projectFiles = visibleFiles();
    check(
      failures,
      JSON.stringify(evidence.projectFiles) === JSON.stringify([...startFiles, ...added].sort()),
      `the project folder holds ${JSON.stringify(evidence.projectFiles)}`,
    );
    const leftovers = readdirSync(projectDir, { recursive: true }).filter((f) =>
      REFUSED.some((name) => basename(String(f)).startsWith(name.replace(/\.\w+$/, ""))),
    );
    check(failures, leftovers.length === 0, `refused files left behind: ${leftovers.join(", ")}`);
    check(
      failures,
      readFileSync(join(projectDir, "clip.mp4")).equals(readFileSync(sourcePath)),
      "clip.mp4 was not stored byte for byte",
    );

    // 3. Each card shows the facts of its file.
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="asset-media-facts"]').length >= n,
      { timeout: 30_000 },
      added.length,
    );
    evidence.facts = await readCardFacts(page);
    for (const [name, facts] of Object.entries(EXPECTED_FACTS)) {
      check(
        failures,
        evidence.facts[name] === facts,
        `${name} shows "${evidence.facts[name]}", not "${facts}"`,
      );
    }
    await shot("media-import");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/** Good and bad files beside the gate's clip; returns their paths. */
function makeMedia(dir) {
  const path = (name) => join(dir, name);
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=1",
    "-pix_fmt",
    "yuv420p",
    path("silent.mp4"),
  );
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=200x100", "-frames:v", "1", path("still.png"));
  ffmpeg("-f", "lavfi", "-i", "sine=duration=1:sample_rate=48000", path("tone.wav"));
  writeFileSync(path("broken.png"), readFileSync(path("still.png")).subarray(0, 100));
  writeFileSync(path("broken.mp4"), Buffer.alloc(4000, 0x5a));
  writeFileSync(path("notes.txt"), "not media");
  return ["silent.mp4", "still.png", "tone.wav", ...REFUSED].map(path);
}

/** File name to the facts line of its card or row (cards carry `data-asset-path`). */
function readCardFacts(page) {
  return page.$$eval('[data-testid="asset-media-facts"]', (els) =>
    Object.fromEntries(
      els.map((el) => [el.closest("[data-asset-path]")?.dataset.assetPath, el.textContent]),
    ),
  );
}
