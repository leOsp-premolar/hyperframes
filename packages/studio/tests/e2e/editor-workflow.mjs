#!/usr/bin/env node
// The whole editing loop on an empty project, through the real UI: import a clip, place it on the
// timeline, split it, trim it, undo and redo, reload, export, then check the exported file itself.
// The project is reset from fixtures/editor-workflow on every run, so the gate can be rerun as is.
//
//   cp -R tests/e2e/fixtures/editor-workflow data/projects/   # done by the gate itself
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/editor-workflow" node tests/e2e/editor-workflow.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchStudioChrome } from "./chrome-executable.mjs";
import { hoverClipEndEdge } from "./timelineGestures.mjs";

const PROJECT_ID = "editor-workflow";
const STUDIO_URL = process.env.STUDIO_URL;
const OUT_DIR = process.env.OUT_DIR;
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 240_000);
const FPS = 30;
const CLIP_SECONDS = 4;
const SPLIT_AT_S = 1.5;
const TRIMMED_END_S = 3;
// Studio saves clip times to the centisecond.
const TIME_TOLERANCE_S = 0.02;
// The source's loudness, carried through the browser and the mixer.
const AUDIO_TOLERANCE_DB = 1.5;

if (!STUDIO_URL || !STUDIO_URL.endsWith(`#project/${PROJECT_ID}`)) {
  console.error(`STUDIO_URL is required and must point at the ${PROJECT_ID} fixture`);
  process.exit(2);
}
for (const tool of ["ffmpeg", "ffprobe"]) {
  if (spawnSync(tool, ["-version"], { stdio: "ignore" }).status !== 0) {
    console.error(`${tool} is required to make the source clip and to inspect the export`);
    process.exit(2);
  }
}

const studioDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
const projectDir = join(studioDir, "data", "projects", PROJECT_ID);
const rendersDir = join(studioDir, "data", "renders");
const origin = new URL(STUDIO_URL).origin;

// A fresh project every run: the fixture is an empty composition.
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(dirname(projectDir), { recursive: true });
cpSync(join(studioDir, "tests", "e2e", "fixtures", PROJECT_ID), projectDir, { recursive: true });

// A source with motion and a frame counter on every frame, and a steady tone.
const workDir = mkdtempSync(join(tmpdir(), "hf-editor-workflow-"));
const sourcePath = join(workDir, "clip.mp4");
run("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=640x360:rate=${FPS}:duration=${CLIP_SECONDS}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:duration=${CLIP_SECONDS}:sample_rate=48000`,
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  sourcePath,
]);

const failures = [];
const evidence = {};
const { browser } = await launchStudioChrome();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(STUDIO_URL, { waitUntil: "domcontentloaded" });

  const frames = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const shot = (name) => (OUT_DIR ? page.screenshot({ path: `${OUT_DIR}/${name}.png` }) : null);
  const timelineClips = () =>
    page.$$eval(".timeline-clip", (els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          const id = el.dataset.elId ?? "";
          return {
            id: id.slice(id.indexOf("#") + 1),
            start: Number(el.dataset.clipStart),
            end: Number(el.dataset.clipEnd),
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
          };
        })
        .sort((a, b) => a.start - b.start),
    );
  const clipCount = (n) =>
    page.waitForFunction(
      (n) => document.querySelectorAll(".timeline-clip").length === n,
      {
        timeout: 20_000,
      },
      n,
    );
  // Dock tabs and toolbar buttons answer pointer events, so press them with the real mouse.
  const clickLeafText = async (text) => {
    const handle = await page.waitForFunction(
      (t) => {
        const el = [...document.querySelectorAll("*")].find(
          (e) => e.children.length === 0 && e.textContent.trim() === t,
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      { timeout: 60_000 },
      text,
    );
    const p = await handle.jsonValue();
    await page.mouse.click(p.x, p.y);
  };

  // 1. Import the clip through the Assets tab's file picker.
  await clickLeafText("Assets");
  const input = await page.waitForSelector('input[type="file"]', { timeout: 10_000 });
  await input.uploadFile(sourcePath);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[draggable="true"]')].some((el) =>
        el.textContent.includes("clip"),
      ),
    { timeout: 30_000 },
  );
  evidence.imported = existsSync(join(projectDir, "clip.mp4"));
  if (!evidence.imported) failures.push("the imported clip was not written into the project");

  // 2. Drag the asset card onto the empty timeline. The card's own dragstart fills the
  // DataTransfer and the timeline's own drop handler reads it; only the pointer travel is synthetic.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("*")].some(
        (e) => e.children.length === 0 && e.textContent.trim().startsWith("Drop media here"),
      ),
    { timeout: 20_000 },
  );
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('[draggable="true"]')].find((el) =>
      el.textContent.includes("clip"),
    );
    const hint = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && e.textContent.trim().startsWith("Drop media here"),
    );
    const r = hint.getBoundingClientRect();
    const x = r.x + 10;
    const y = r.y - 80;
    const target = document.elementFromPoint(x, y);
    const dataTransfer = new DataTransfer();
    card.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
    );
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: x,
          clientY: y,
        }),
      );
    }
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  });
  await clipCount(1);
  const placed = await waitForDisk(
    (clips) =>
      clips.length === 1 && near(clips[0].start, 0) && near(clips[0].duration, CLIP_SECONDS),
  );
  evidence.placed = placed;
  await page.waitForSelector("[data-timeline-playhead-layer] > *", { timeout: 30_000 });
  await shot("1-placed");

  // 3. Park the playhead with a ruler click, select the clip and split it.
  const [whole] = await timelineClips();
  const pps = whole.width / (whole.end - whole.start);
  const originX = whole.x - whole.start * pps;
  const ruler = await page.$eval("[data-timeline-grid-cell]", (el) => el.getBoundingClientRect().y);
  await page.mouse.click(originX + SPLIT_AT_S * pps, ruler + 6);
  await frames();
  await page.mouse.click(whole.x + 20, whole.y + whole.height / 2);
  await frames();
  await page.click('button[aria-label="Split at playhead"]');
  await clipCount(2);
  const split = await waitForDisk(
    (clips) =>
      clips.length === 2 &&
      near(clips[0].duration, SPLIT_AT_S) &&
      near(clips[1].start, SPLIT_AT_S) &&
      near(clips[1].mediaStart, SPLIT_AT_S),
  );
  evidence.split = split;
  await shot("2-split");

  // 4. Trim the second piece's end edge back by a second; the handle mounts on hover.
  const second = (await timelineClips())[1];
  const secondSelector = `.timeline-clip[data-el-id$="#${second.id}"]`;
  const { edgeX, midY } = await hoverClipEndEdge(page, secondSelector, second);
  await page.mouse.down();
  const trimPx = (TRIMMED_END_S - second.end) * pps;
  for (const part of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(edgeX + trimPx * part, midY);
    await frames();
  }
  await page.mouse.up();
  const trimmed = await waitForDisk(
    (clips) => clips.length === 2 && near(clips[1].start + clips[1].duration, TRIMMED_END_S),
  );
  evidence.trimmed = trimmed;
  await shot("3-trimmed");

  // 5. Undo restores the trimmed tail, redo trims it again, on screen and on disk.
  await page.click('button[aria-label="Undo"]');
  await waitForDisk(
    (clips) => clips.length === 2 && near(clips[1].start + clips[1].duration, CLIP_SECONDS),
  );
  await page.click('button[aria-label="Redo"]');
  await waitForDisk(
    (clips) => clips.length === 2 && near(clips[1].start + clips[1].duration, TRIMMED_END_S),
  );
  evidence.undoRedo = "ok";

  // 6. The edit survives a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await clipCount(2);
  const reloaded = (await timelineClips()).map(({ id, start, end }) => ({ id, start, end }));
  evidence.reloaded = reloaded;
  if (!(near(reloaded[0].end, SPLIT_AT_S) && near(reloaded[1].end, TRIMMED_END_S))) {
    failures.push(`after a reload the timeline shows ${JSON.stringify(reloaded)}`);
  }

  // 7. Export with the header button, as a user would, and follow that job to its end.
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith(`/api/projects/${PROJECT_ID}/render`),
    { timeout: 30_000 },
  );
  await page.click('[data-testid="header-export"]');
  const { jobId } = await (await posted).json();
  const startedAt = Date.now();
  const outcome = await followRender(jobId);
  await shot("4-exported");
  evidence.render = { jobId, ...outcome, seconds: round3((Date.now() - startedAt) / 1000) };
  if (outcome.status !== "complete") {
    throw new Error(
      `the render ${jobId} ended ${outcome.status}: ${outcome.error ?? "no error given"}`,
    );
  }

  // 8. The file reflects the edit: the cut length, both streams, the source frames, the tone.
  const outputPath = join(rendersDir, `${jobId}.mp4`);
  const probe = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate",
      "-of",
      "json",
      outputPath,
    ]),
  );
  const video = probe.streams.find((s) => s.codec_type === "video");
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  const duration = Number(probe.format.duration);
  evidence.output = { duration, video, audio };
  if (Math.abs(duration - TRIMMED_END_S) > 1 / FPS) {
    failures.push(`the export lasts ${duration}s, not the edited ${TRIMMED_END_S}s`);
  }
  if (!video || video.width !== 640 || video.height !== 360 || video.r_frame_rate !== `${FPS}/1`) {
    failures.push(`unexpected video stream ${JSON.stringify(video)}`);
  }
  if (!audio) failures.push("the export has no audio stream");

  // Each sampled frame must match the source frame at the same moment better than its neighbours
  // and better than the frame a split that lost its source offset would show (t - SPLIT_AT_S).
  evidence.frames = [];
  for (const t of [0.5, 1, 2, 2.5]) {
    const candidates = [-3, -2, -1, 0, 1, 2, 3].map((k) => round3(t + k / FPS));
    if (t > SPLIT_AT_S) candidates.push(round3(t - SPLIT_AT_S));
    const scores = candidates
      .filter((s) => s >= 0 && s < CLIP_SECONDS)
      .map((s) => ({ s, psnr: framePsnr(outputPath, t, sourcePath, s) }));
    const best = scores.reduce((a, b) => (b.psnr > a.psnr ? b : a));
    evidence.frames.push({ t, bestSourceS: best.s, psnr: round3(best.psnr) });
    if (best.s !== t) failures.push(`export frame at ${t}s matches source ${best.s}s, not ${t}s`);
  }

  const sourceDb = meanVolume(sourcePath, 0, CLIP_SECONDS);
  const windows = [
    [0.2, SPLIT_AT_S - 0.2],
    [SPLIT_AT_S + 0.2, TRIMMED_END_S - 0.2],
  ];
  evidence.audio = { sourceDb, windows: [] };
  for (const [from, to] of windows) {
    const db = meanVolume(outputPath, from, to - from);
    evidence.audio.windows.push({ from, to, db });
    if (!(Math.abs(db - sourceDb) <= AUDIO_TOLERANCE_DB)) {
      failures.push(`audio between ${from}s and ${to}s is ${db} dB; the source is ${sourceDb} dB`);
    }
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ evidence, failures }, null, 2));
if (failures.length > 0) process.exit(1);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || "").slice(-400)}`);
  return r.stdout;
}

function near(a, b) {
  return Math.abs(a - b) <= TIME_TOLERANCE_S;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** The project's video clips as saved in index.html, in timeline order. */
function savedClips() {
  const html = readFileSync(join(projectDir, "index.html"), "utf8");
  return [...html.matchAll(/<video\b[^>]*>/g)]
    .map(([tag]) => {
      const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
      return {
        id: attr("id"),
        src: attr("src"),
        start: Number(attr("data-start")),
        duration: Number(attr("data-duration")),
        mediaStart: Number(attr("data-media-start") ?? 0),
      };
    })
    .sort((a, b) => a.start - b.start);
}

/** Saves land a moment after the gesture; wait for the file to say what the timeline says. */
async function waitForDisk(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let clips = savedClips();
  while (!predicate(clips)) {
    if (Date.now() > deadline) {
      throw new Error(`index.html never reached the expected state: ${JSON.stringify(clips)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
    clips = savedClips();
  }
  return clips;
}

/** Read the job's progress stream until it leaves "rendering"; the last event is the outcome. */
async function followRender(jobId) {
  const body = await streamBody(`${origin}/api/render/${encodeURIComponent(jobId)}/progress`);
  const reader = sseDataReader();
  let last = { status: "rendering" };
  for await (const chunk of body) {
    for (const event of reader(chunk)) last = event;
    if (last.status !== "rendering") break;
  }
  return { status: last.status, stage: last.stage, error: last.error };
}

async function streamBody(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`GET ${url} answered ${res.status}`);
  return res.body;
}

/** Feed it stream chunks; it returns the JSON payloads of the `data:` lines completed so far. */
function sseDataReader() {
  const decoder = new TextDecoder();
  let buffered = "";
  return (chunk) => {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    return lines.filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  };
}

function framePsnr(a, at, b, bt) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-ss",
      String(at),
      "-i",
      a,
      "-ss",
      String(bt),
      "-i",
      b,
      "-frames:v",
      "1",
      "-lavfi",
      "[0:v][1:v]psnr",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const m = r.stderr.match(/average:([0-9.]+|inf)/);
  if (!m) throw new Error(`could not compare frames ${at}s and ${bt}s: ${r.stderr.slice(-200)}`);
  return m[1] === "inf" ? Infinity : Number(m[1]);
}

function meanVolume(file, from, length) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-ss",
      String(from),
      "-t",
      String(length),
      "-i",
      file,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const m = r.stderr.match(/mean_volume:\s*(-?[0-9.]+|-inf) dB/);
  return m ? Number(m[1]) : -Infinity;
}
