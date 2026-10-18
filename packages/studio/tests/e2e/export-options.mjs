#!/usr/bin/env node
// The Renders panel's export options through the real UI: mark an in/out range with I and O,
// then export it as MP4, GIF, a PNG sequence and WAV, and the whole timeline as MP3; each file is
// checked against the source clip (length, frames from the in point, sound). The header's Export
// then uses the settings last chosen in the panel.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/export-options" node tests/e2e/export-options.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RENDERS_DIR,
  check,
  followRender,
  framePsnr,
  meanVolume,
  runStudioGate,
  studioGateSetup,
} from "./editorWorkflowSteps.mjs";

const PROJECT_ID = "export-options";
const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);
const origin = new URL(STUDIO_URL ?? "http://localhost").origin;
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 240_000);
const IN_S = 1;
const OUT_S = 3;
const FPS = 30;
const EXT_BY_LABEL = {
  MP4: ".mp4",
  GIF: ".gif",
  "PNG sequence (.zip)": ".zip",
  "Audio: WAV": ".wav",
  "Audio: MP3": ".mp3",
};

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const { page, sourcePath, shot, evidence, failures } = gate;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  copyFileSync(sourcePath, join(projectDir, "assets", "clip.mp4"));
  await page.reload({ waitUntil: "domcontentloaded" });
  const work = mkdtempSync(join(tmpdir(), "hf-export-options-"));
  try {
    evidence.marked = await markInOut(page);
    await openRendersTab(page);
    await choose(page, "Range", "In to out");
    evidence.rangeLabel = await page.$eval(
      '[role="combobox"][aria-label="Range"]',
      (el) => el.textContent,
    );
    check(
      failures,
      evidence.rangeLabel.includes("00:01.00 to 00:03.00"),
      `the range reads "${evidence.rangeLabel}"`,
    );

    const range = (label) => exportAs(page, label, evidence);
    checkVideo(await range("MP4"), sourcePath, evidence, failures);
    checkGif(await range("GIF"), evidence, failures);
    const rangeFrames = await range("PNG sequence (.zip)");
    checkFrames(rangeFrames, work, evidence, failures);
    checkSound(
      await range("Audio: WAV"),
      sourcePath,
      OUT_S - IN_S,
      "pcm_s16le",
      evidence,
      failures,
    );
    await choose(page, "Range", "Whole timeline");
    checkSound(await range("Audio: MP3"), sourcePath, 4, "mp3", evidence, failures);
    checkFramesFromIn(rangeFrames, await range("PNG sequence (.zip)"), work, evidence, failures);
    await shot("export-options");

    evidence.listKinds = await page.$$eval("[data-render-kind]", (els) =>
      els.map((el) => el.getAttribute("data-render-kind")),
    );
    check(
      failures,
      ["audio", "frames"].every((kind) => evidence.listKinds.includes(kind)),
      `the Renders list shows ${JSON.stringify(evidence.listKinds)}`,
    );

    // The header's Export uses what the panel chose last: PNG sequence, whole timeline.
    const posted = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith(`/api/projects/${PROJECT_ID}/render`),
    );
    await page.click('[data-testid="header-export"]');
    evidence.headerExport = JSON.parse((await posted).postData() ?? "{}");
    check(
      failures,
      evidence.headerExport.format === "png-sequence",
      "the header Export ignored the saved format",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    evidence.pageErrors = pageErrors;
    check(failures, pageErrors.length === 0, `the page threw: ${pageErrors.join(" | ")}`);
  }
});

/** Park the playhead with ruler clicks and press I, then O, as an editor does. */
async function markInOut(page) {
  await page.waitForSelector('.timeline-clip[data-el-id$="#clip"]', { timeout: 60_000 });
  const clip = await page.$eval('.timeline-clip[data-el-id$="#clip"]', (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      width: r.width,
      start: Number(el.dataset.clipStart),
      end: Number(el.dataset.clipEnd),
    };
  });
  const pps = clip.width / (clip.end - clip.start);
  const ruler = await page.$eval("[data-timeline-grid-cell]", (el) => el.getBoundingClientRect().y);
  for (const [time, key] of [
    [IN_S, "i"],
    [OUT_S, "o"],
  ]) {
    await page.mouse.click(clip.x + (time - clip.start) * pps, ruler + 6);
    await page.keyboard.press(key);
  }
  return { pps };
}

/** The Renders tab's label carries the render count ("Renders (3)"); press it with the mouse. */
async function openRendersTab(page) {
  const handle = await page.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("*")].find(
        (e) => e.children.length === 0 && /^Renders( \(\d+\))?$/.test(e.textContent.trim()),
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    { timeout: 60_000 },
  );
  const p = await handle.jsonValue();
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('[data-testid="renders-export"]', { timeout: 30_000 });
}

/** Open the Select labelled `label` and pick the option whose text starts with `text`. */
async function choose(page, label, text) {
  await page.click(`[role="combobox"][aria-label="${label}"]`);
  const option = await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll('[role="option"]')].find((el) =>
        el.textContent.trim().startsWith(t),
      ),
    { timeout: 10_000 },
    text,
  );
  await option.asElement().click();
}

/** Pick the format, press the panel's Export, follow the job and return the file it made. */
async function exportAs(page, formatLabel, evidence) {
  await choose(page, "Format", formatLabel);
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith(`/api/projects/${PROJECT_ID}/render`),
    { timeout: 30_000 },
  );
  await page.click('[data-testid="renders-export"]');
  const response = await posted;
  const { jobId } = await response.json();
  const outcome = await followRender(origin, jobId, RENDER_TIMEOUT_MS);
  evidence[formatLabel] = { jobId, ...outcome, request: response.request().postData() };
  if (outcome.status !== "complete") {
    throw new Error(
      `${formatLabel} export ended ${outcome.status}: ${outcome.error ?? "no error"}`,
    );
  }
  // Wait for the Export button to come back before the next export.
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="renders-export"]')?.hasAttribute("disabled"),
    { timeout: 30_000 },
  );
  return join(RENDERS_DIR, `${jobId}${EXT_BY_LABEL[formatLabel]}`);
}

function probe(file, entries) {
  return spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", "--", file],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
}

function near(a, b, tolerance = 1.5 / FPS) {
  return Math.abs(a - b) <= tolerance;
}

/** The export frame at `t` must match the source at IN_S + t better than the frames beside it. */
function matchesFromIn(file, sourcePath, t, evidence, failures, key) {
  const scores = [-2, -1, 0, 1, 2].map((k) => ({
    offset: k,
    psnr: framePsnr(file, t, sourcePath, IN_S + t + k / FPS),
  }));
  const best = scores.reduce((a, b) => (b.psnr > a.psnr ? b : a));
  evidence[key] = { t, scores };
  check(
    failures,
    best.offset === 0,
    `${key}: frame ${t}s matches source ${IN_S + t + best.offset / FPS}s`,
  );
}

function checkVideo(file, sourcePath, evidence, failures) {
  const duration = Number(probe(file, "format=duration"));
  evidence.mp4 = { duration, streams: probe(file, "stream=codec_name") };
  check(failures, near(duration, OUT_S - IN_S), `the MP4 lasts ${duration}s, not ${OUT_S - IN_S}s`);
  check(failures, evidence.mp4.streams === "h264\naac", `the MP4 has ${evidence.mp4.streams}`);
  matchesFromIn(file, sourcePath, 0.5, evidence, failures, "mp4Frame");
}

function checkGif(file, evidence, failures) {
  const duration = Number(probe(file, "format=duration"));
  evidence.gif = { duration, codec: probe(file, "stream=codec_name") };
  check(failures, evidence.gif.codec === "gif", `the GIF is ${evidence.gif.codec}`);
  check(failures, near(duration, OUT_S - IN_S, 0.1), `the GIF lasts ${duration}s`);
}

function zipNames(zip) {
  return spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.trim().split("\n");
}

function checkFrames(zip, work, evidence, failures) {
  const names = zipNames(zip);
  const frames = names.filter((n) => n.endsWith(".png"));
  evidence.png = { frames: frames.length, first: frames[0], audio: names.includes("audio.m4a") };
  check(failures, frames.length === (OUT_S - IN_S) * FPS, `the zip holds ${frames.length} frames`);
  check(failures, frames[0] === "frame_000001.png", `the first frame is ${frames[0]}`);
  check(failures, evidence.png.audio, "the zip has no audio.m4a");
}

/** The range's frame N is, byte for byte, the whole timeline's frame at the in point plus N. */
function checkFramesFromIn(rangeZip, wholeZip, work, evidence, failures) {
  const [range, whole] = [join(work, "range"), join(work, "whole")];
  spawnSync("unzip", ["-q", rangeZip, "-d", range]);
  spawnSync("unzip", ["-q", wholeZip, "-d", whole]);
  const frame = (n) => `frame_${String(n).padStart(6, "0")}.png`;
  const same = (a, b) => readFileSync(a).equals(readFileSync(b));
  const pairs = [1, 30, 60].map((n) => ({
    range: frame(n),
    whole: frame(n + IN_S * FPS),
    identical: same(join(range, frame(n)), join(whole, frame(n + IN_S * FPS))),
  }));
  evidence.pngFromIn = { wholeFrames: zipNames(wholeZip).length, pairs };
  check(
    failures,
    pairs.every((p) => p.identical),
    `range frames are not the whole timeline's from the in point: ${JSON.stringify(pairs)}`,
  );
}

function checkSound(file, sourcePath, seconds, codec, evidence, failures) {
  const facts = probe(file, "stream=codec_type,codec_name");
  const duration = Number(probe(file, "format=duration"));
  const db = meanVolume(file, 0.2, Math.max(0.2, seconds - 0.4));
  const sourceDb = meanVolume(sourcePath, 0.2, 3.6);
  evidence[codec] = { facts, duration, db, sourceDb };
  check(failures, facts === `${codec},audio`, `the ${codec} export has ${facts}`);
  check(
    failures,
    near(duration, seconds, 0.1),
    `the ${codec} export lasts ${duration}s, not ${seconds}s`,
  );
  check(
    failures,
    Math.abs(db - sourceDb) <= 1.5,
    `the ${codec} export is ${db} dB; the source ${sourceDb} dB`,
  );
}
