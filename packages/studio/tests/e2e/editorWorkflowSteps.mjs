// The editing loop shared by the editor-workflow and create-project-workflow gates: import a clip
// through the Assets tab, place it, split it, trim it, undo and redo, reload, export with the
// header button, then check the exported file itself.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchStudioChrome } from "./chrome-executable.mjs";
import { hoverClipEndEdge } from "./timelineGestures.mjs";

const FPS = 30;
const CLIP_SECONDS = 4;
const SPLIT_AT_S = 1.5;
const TRIMMED_END_S = 3;
// Studio saves clip times to the centisecond.
const TIME_TOLERANCE_S = 0.02;
// The source's loudness, carried through the browser and the mixer.
const AUDIO_TOLERANCE_DB = 1.5;

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** Where the dev server keeps projects and renders (both gitignored). */
export const PROJECTS_DIR = join(STUDIO_DIR, "data", "projects");
export const RENDERS_DIR = join(STUDIO_DIR, "data", "renders");

/**
 * Check what every gate needs before it starts: STUDIO_URL opening `fixtureId`, ffmpeg and
 * ffprobe. Exits 2 like the other gates when one is missing. Then resets the fixture project
 * from tests/e2e/fixtures, so a gate can be rerun as is, and returns its folder.
 */
export function studioGateSetup(studioUrl, fixtureId) {
  if (!studioUrl || !studioUrl.endsWith(`#project/${fixtureId}`)) {
    console.error(`STUDIO_URL is required and must point at the ${fixtureId} fixture`);
    process.exit(2);
  }
  requireMediaTools();
  const projectDir = join(PROJECTS_DIR, fixtureId);
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  cpSync(join(STUDIO_DIR, "tests", "e2e", "fixtures", fixtureId), projectDir, { recursive: true });
  return projectDir;
}

/**
 * Open Studio at `studioUrl`, hand `body` the page, a fresh source clip, a screenshot helper and
 * the evidence/failures it fills, then print them as JSON and exit 1 on any failure.
 */
export async function runStudioGate({ studioUrl, outDir }, body) {
  const workDir = mkdtempSync(join(tmpdir(), "hf-studio-gate-"));
  const sourcePath = makeSourceClip(join(workDir, "clip.mp4"));
  const failures = [];
  const evidence = {};
  const { browser } = await launchStudioChrome();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(studioUrl, { waitUntil: "domcontentloaded" });
    const shot = (name) => (outDir ? page.screenshot({ path: `${outDir}/${name}.png` }) : null);
    await body({ page, sourcePath, shot, evidence, failures });
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    await browser.close();
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ evidence, failures }, null, 2));
  if (failures.length > 0) process.exit(1);
}

/** The empty timeline's drop hint: the project is open and has no clip yet. */
export function waitForEmptyTimeline(page) {
  return page.waitForFunction(
    () =>
      [...document.querySelectorAll("*")].some(
        (e) => e.children.length === 0 && e.textContent.trim().startsWith("Drop media here"),
      ),
    { timeout: 30_000 },
  );
}

/** Exit 2, as the other gates do, when a tool the gate needs is missing. */
function requireMediaTools() {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    if (spawnSync(tool, ["-version"], { stdio: "ignore" }).status !== 0) {
      console.error(`${tool} is required to make the source clip and to inspect the export`);
      process.exit(2);
    }
  }
}

/** A 640x360 source with motion and a frame counter on every frame, and a steady tone. */
function makeSourceClip(path) {
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
    path,
  ]);
  return path;
}

/** Record a failure unless `ok`; the gate goes on, so one run reports every finding. */
export function check(failures, ok, message) {
  if (!ok) failures.push(message);
}

/**
 * Run the loop on the project open in `page`. Findings go to `failures`, measurements to
 * `evidence`; a step that cannot continue throws.
 */
export async function runEditWorkflow(options) {
  const ctx = {
    ...options,
    waitForDisk: (predicate) => waitForSavedClips(options.projectDir, predicate),
  };
  await importClip(ctx);
  await placeOnTimeline(ctx);
  const pps = await splitAtPlayhead(ctx);
  await trimSecondPiece(ctx, pps);
  await undoAndRedoTrim(ctx);
  await reloadKeepsEdit(ctx);
  const jobId = await exportWithHeaderButton(ctx);
  checkExport(join(ctx.rendersDir, `${jobId}.mp4`), ctx);
}

const frames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const clipCount = (page, n) =>
  page.waitForFunction(
    (n) => document.querySelectorAll(".timeline-clip").length === n,
    { timeout: 20_000 },
    n,
  );

const trimmedTo = (end) => (clips) =>
  clips.length === 2 && near(clips[1].start + clips[1].duration, end);

function timelineClips(page) {
  return page.$$eval(".timeline-clip", (els) =>
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
}

// 1. Import the clip through the Assets tab's file picker.
async function importClip({ page, projectDir, sourcePath, evidence, failures }) {
  await clickLeafText(page, "Assets");
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
  check(failures, evidence.imported, "the imported clip was not written into the project");
}

// 2. Drag the asset card onto the empty timeline. The card's own dragstart fills the
// DataTransfer and the timeline's own drop handler reads it; only the pointer travel is synthetic.
async function placeOnTimeline({ page, waitForDisk, shot, evidence }) {
  await waitForEmptyTimeline(page);
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
  await clipCount(page, 1);
  evidence.placed = await waitForDisk(
    (clips) =>
      clips.length === 1 && near(clips[0].start, 0) && near(clips[0].duration, CLIP_SECONDS),
  );
  await page.waitForSelector("[data-timeline-playhead-layer] > *", { timeout: 30_000 });
  await shot("1-placed");
}

// 3. Park the playhead with a ruler click, select the clip and split it. Returns pixels per second.
async function splitAtPlayhead({ page, waitForDisk, shot, evidence }) {
  const [whole] = await timelineClips(page);
  const pps = whole.width / (whole.end - whole.start);
  const originX = whole.x - whole.start * pps;
  const ruler = await page.$eval("[data-timeline-grid-cell]", (el) => el.getBoundingClientRect().y);
  await page.mouse.click(originX + SPLIT_AT_S * pps, ruler + 6);
  await frames(page);
  await page.mouse.click(whole.x + 20, whole.y + whole.height / 2);
  await frames(page);
  await page.click('button[aria-label="Split at playhead"]');
  await clipCount(page, 2);
  evidence.split = await waitForDisk(
    (clips) =>
      clips.length === 2 &&
      near(clips[0].duration, SPLIT_AT_S) &&
      near(clips[1].start, SPLIT_AT_S) &&
      near(clips[1].mediaStart, SPLIT_AT_S),
  );
  await shot("2-split");
  return pps;
}

// 4. Trim the second piece's end edge back by a second; the handle mounts on hover.
async function trimSecondPiece({ page, waitForDisk, shot, evidence }, pps) {
  const second = (await timelineClips(page))[1];
  const secondSelector = `.timeline-clip[data-el-id$="#${second.id}"]`;
  const { edgeX, midY } = await hoverClipEndEdge(page, secondSelector, second);
  await page.mouse.down();
  const trimPx = (TRIMMED_END_S - second.end) * pps;
  for (const part of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(edgeX + trimPx * part, midY);
    await frames(page);
  }
  await page.mouse.up();
  evidence.trimmed = await waitForDisk(trimmedTo(TRIMMED_END_S));
  await shot("3-trimmed");
}

// 5. Undo restores the trimmed tail, redo trims it again, on screen and on disk.
async function undoAndRedoTrim({ page, waitForDisk, evidence }) {
  await page.click('button[aria-label="Undo"]');
  await waitForDisk(trimmedTo(CLIP_SECONDS));
  await page.click('button[aria-label="Redo"]');
  await waitForDisk(trimmedTo(TRIMMED_END_S));
  evidence.undoRedo = "ok";
}

// 6. The edit survives a reload.
async function reloadKeepsEdit({ page, evidence, failures }) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await clipCount(page, 2);
  const reloaded = (await timelineClips(page)).map(({ id, start, end }) => ({ id, start, end }));
  evidence.reloaded = reloaded;
  check(
    failures,
    near(reloaded[0].end, SPLIT_AT_S) && near(reloaded[1].end, TRIMMED_END_S),
    `after a reload the timeline shows ${JSON.stringify(reloaded)}`,
  );
}

// 7. Export with the header button, as a user would, and follow that job to its end.
export async function exportWithHeaderButton({
  page,
  origin,
  projectId,
  renderTimeoutMs,
  shot,
  evidence,
}) {
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/projects/${projectId}/render`),
    { timeout: 30_000 },
  );
  await page.click('[data-testid="header-export"]');
  const { jobId } = await (await posted).json();
  const startedAt = Date.now();
  const outcome = await followRender(origin, jobId, renderTimeoutMs);
  await shot("4-exported");
  evidence.render = { jobId, ...outcome, seconds: round3((Date.now() - startedAt) / 1000) };
  if (outcome.status !== "complete") {
    throw new Error(
      `the render ${jobId} ended ${outcome.status}: ${outcome.error ?? "no error given"}`,
    );
  }
  return jobId;
}

// 8. The file reflects the edit: the cut length, both streams, the source frames, the tone.
function checkExport(outputPath, { sourcePath, frameSize, evidence, failures }) {
  checkStreams(outputPath, frameSize, evidence, failures);
  checkFrames(outputPath, sourcePath, evidence, failures);
  checkAudio(outputPath, sourcePath, evidence, failures);
}

function checkStreams(outputPath, frameSize, evidence, failures) {
  const probe = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate",
      "-of",
      "json",
      "--",
      outputPath,
    ]),
  );
  const video = probe.streams.find((s) => s.codec_type === "video") ?? {};
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  const duration = Number(probe.format.duration);
  evidence.output = { duration, video, audio };
  check(
    failures,
    Math.abs(duration - TRIMMED_END_S) <= 1 / FPS,
    `the export lasts ${duration}s, not the edited ${TRIMMED_END_S}s`,
  );
  const shape = `${video.width}x${video.height}@${video.r_frame_rate}`;
  check(
    failures,
    shape === `${frameSize.width}x${frameSize.height}@${FPS}/1`,
    `unexpected video stream ${JSON.stringify(video)}`,
  );
  check(failures, Boolean(audio), "the export has no audio stream");
}

// Each sampled frame must match the source frame at the same moment better than its neighbours
// and better than the frame a split that lost its source offset would show (t - SPLIT_AT_S).
function checkFrames(outputPath, sourcePath, evidence, failures) {
  evidence.frames = [];
  for (const t of [0.5, 1, 2, 2.5]) {
    const candidates = [-3, -2, -1, 0, 1, 2, 3].map((k) => round3(t + k / FPS));
    if (t > SPLIT_AT_S) candidates.push(round3(t - SPLIT_AT_S));
    const scores = candidates
      .filter((s) => s >= 0 && s < CLIP_SECONDS)
      .map((s) => ({ s, psnr: framePsnr(outputPath, t, sourcePath, s) }));
    const best = scores.reduce((a, b) => (b.psnr > a.psnr ? b : a));
    evidence.frames.push({ t, bestSourceS: best.s, psnr: round3(best.psnr) });
    check(failures, best.s === t, `export frame at ${t}s matches source ${best.s}s, not ${t}s`);
  }
}

function checkAudio(outputPath, sourcePath, evidence, failures) {
  const sourceDb = meanVolume(sourcePath, 0, CLIP_SECONDS);
  const windows = [
    [0.2, SPLIT_AT_S - 0.2],
    [SPLIT_AT_S + 0.2, TRIMMED_END_S - 0.2],
  ];
  evidence.audio = { sourceDb, windows: [] };
  for (const [from, to] of windows) {
    const db = meanVolume(outputPath, from, to - from);
    evidence.audio.windows.push({ from, to, db });
    check(
      failures,
      Math.abs(db - sourceDb) <= AUDIO_TOLERANCE_DB,
      `audio between ${from}s and ${to}s is ${db} dB; the source is ${sourceDb} dB`,
    );
  }
}

/** Dock tabs and toolbar buttons answer pointer events, so press them with the real mouse. */
export async function clickLeafText(page, text) {
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
}

/** Run ffmpeg quietly, overwriting its output; a failure throws with the end of its errors. */
export function ffmpeg(...args) {
  run("ffmpeg", ["-v", "error", "-y", ...args]);
}

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
function readSavedClips(projectDir) {
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
async function waitForSavedClips(projectDir, predicate, timeoutMs = 15_000) {
  const read = () => readSavedClips(projectDir);
  const deadline = Date.now() + timeoutMs;
  let clips = read();
  while (!predicate(clips)) {
    if (Date.now() > deadline) {
      throw new Error(`index.html never reached the expected state: ${JSON.stringify(clips)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
    clips = read();
  }
  return clips;
}

/** Read the job's progress stream until it leaves "rendering"; the last event is the outcome. */
export async function followRender(origin, jobId, timeoutMs) {
  const body = await streamBody(
    `${origin}/api/render/${encodeURIComponent(jobId)}/progress`,
    timeoutMs,
  );
  const reader = sseDataReader();
  let last = { status: "rendering" };
  for await (const chunk of body) {
    for (const event of reader(chunk)) last = event;
    if (last.status !== "rendering") break;
  }
  return { status: last.status, stage: last.stage, error: last.error };
}

async function streamBody(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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

/** How closely frame `at` of `a` matches frame `bt` of `b`, in dB (Infinity when identical). */
export function framePsnr(a, at, b, bt) {
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

export function meanVolume(file, from, length) {
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
