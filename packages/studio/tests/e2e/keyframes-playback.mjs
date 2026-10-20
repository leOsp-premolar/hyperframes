#!/usr/bin/env node
// Keyframes and playback through the real UI on one red box. "Add keyframe at playhead" keys
// its position at 0s; a canvas drag at 2s, with auto-key on, keys it again 200px to the right.
// The file holds both keyframes, the timeline shows both diamonds, and seeking the preview
// between them interpolates. Play then runs at real time (and twice that at 2x), drives the box
// along its path, pauses, loops, and steps a frame with the arrow key. Undo and redo the second
// keyframe, reload, and the export draws the box where the preview did.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/keyframes-playback" node tests/e2e/keyframes-playback.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  RENDERS_DIR,
  check,
  exportWithHeaderButton,
  runStudioGate,
  studioGateSetup,
} from "./editorWorkflowSteps.mjs";
import { clipBox } from "./timelineGestures.mjs";

const PROJECT_ID = "keyframes-playback";
const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);
const FPS = 30;
const DX = 200;
// The box's left edge in the composition before any transform, and its width.
const BOX_LEFT = 40;
const BOX_SIZE = 80;
const AUTO_KEY = 'button[aria-label="Auto-record manual edits as keyframes"]';
const readScript = () => readFileSync(join(projectDir, "index.html"), "utf8");

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const { page, evidence, failures } = gate;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  copyGsap();
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await waitReady(page);
    await keyTwice(gate);
    await checkSeeks(gate);
    await checkPlaybackControls(gate);
    await checkUndoAndReload(gate);
    await checkExport(gate);
  } finally {
    evidence.pageErrors = pageErrors;
    check(failures, pageErrors.length === 0, `the page threw: ${pageErrors.join(" | ")}`);
  }
});

/** Key the box at 0s with the toolbar, then at 2s by a canvas drag with auto-key on. */
async function keyTwice({ page, shot, evidence, failures }) {
  // Key 1: select the box on the canvas and add a keyframe at 0s.
  await selectBox(page);
  await page.click('button[aria-label^="Add keyframe at playhead"]');
  await waitForScript(/keyframes: \{ "0%": \{ x: 0, y: 0 \} \}/, "the first keyframe");

  // Key 2: auto-key is on by default; at 2s a canvas drag keys the new position.
  evidence.autoKey = await page.$eval(AUTO_KEY, (b) => b.getAttribute("aria-pressed"));
  check(failures, evidence.autoKey === "true", "auto-key was not on");
  await seekRuler(page, 2);
  await dragBox(page, DX);
  evidence.script = await waitForScript(
    new RegExp(
      `"0%": \\{ x: 0, y: 0 \\}, "100%": \\{ x: ${DX}, y: 0 \\} \\}, duration: 2 \\}, 0\\)`,
    ),
    "the second keyframe",
  );
  evidence.diamonds = await waitForDiamonds(page, 2);
  check(
    failures,
    JSON.stringify(evidence.diamonds) ===
      JSON.stringify(["position keyframe at 0s", "position keyframe at 2s"]),
    `the timeline shows ${JSON.stringify(evidence.diamonds)}`,
  );
  // The new key sits on the frame the playhead shows, so the toolbar offers to remove it.
  evidence.toolbarAtKey = await page.$eval('button[aria-label$="keyframe at playhead"]', (b) =>
    b.getAttribute("aria-label"),
  );
  check(
    failures,
    evidence.toolbarAtKey === "Remove keyframe at playhead",
    `at the new key the toolbar offers "${evidence.toolbarAtKey}"`,
  );
  await shot("1-keyed");
}

/** Seeking interpolates between the keys and holds after the last. */
async function checkSeeks({ page, evidence, failures }) {
  // Seeking interpolates between the keys and holds after the last.
  evidence.seeks = [];
  for (const t of [0, 1, 3]) evidence.seeks.push(await seekRuler(page, t));
  const [atStart, atMiddle, atEnd] = evidence.seeks;
  check(failures, near(atStart.x, 0, 1), `at ${atStart.time}s the box is at x ${atStart.x}`);
  check(
    failures,
    atMiddle.x > 20 && atMiddle.x < DX - 20,
    `at ${atMiddle.time}s the box is at x ${atMiddle.x}, not between the keys`,
  );
  check(failures, near(atEnd.x, DX, 1), `at ${atEnd.time}s the box is at x ${atEnd.x}`);
}

/** Play, pause, play past the keys, 2x, loop and a frame step. */
async function checkPlaybackControls({ page, evidence, failures }) {
  // Play from the start: real-time rate, the box follows its path, then Pause holds still
  await page.keyboard.press("Escape");
  await seekRuler(page, 0);
  evidence.play = await playFor(page, 1500);
  checkPlayback(evidence.play, 1, failures, "1x");
  evidence.paused = await pauseAndHold(page);
  check(failures, evidence.paused.held, `pause did not hold: ${JSON.stringify(evidence.paused)}`);
  // and it stops on a frame, where a key added now lands.
  const pausedFrame = evidence.paused.first.time * FPS;
  check(
    failures,
    near(pausedFrame, Math.round(pausedFrame), 1e-6),
    `pause stopped between frames, at ${evidence.paused.first.time}s`,
  );
  // Past the last key the box stays at the end.
  evidence.afterKeys = await playFor(page, 900, 2.1);
  check(
    failures,
    evidence.afterKeys.samples.every((s) => s.time < 2.05 || near(s.x, DX, 1)),
    "the box left its last keyframe while playing",
  );
  await pauseAndHold(page);

  // 2x plays twice as fast.
  await setSpeed(page, "2x");
  await seekRuler(page, 0);
  evidence.play2x = await playFor(page, 1000);
  checkPlayback(evidence.play2x, 2, failures, "2x");
  await pauseAndHold(page);
  await setSpeed(page, "1x");

  // Loop: playing over the end starts again from the beginning.
  await page.click('button[aria-label="Enable loop playback"]');
  await seekRuler(page, 3.5);
  evidence.loop = await playFor(page, 1500);
  const times = evidence.loop.samples.map((s) => s.time);
  check(
    failures,
    times.some((t) => t > 3.4) && times.at(-1) < 1.5,
    `loop playback read ${JSON.stringify(times)}`,
  );
  await pauseAndHold(page);
  await page.click('button[aria-label="Disable loop playback"]');

  // A frame step moves one frame and the box with it.
  const before = await seekRuler(page, 1);
  await page.keyboard.press("ArrowRight");
  const after = await waitForPreview(page, (s) => s.time > before.time + 0.001);
  evidence.step = { before, after };
  check(
    failures,
    near(after.time - before.time, 1 / FPS, 0.002) && after.x > before.x,
    `ArrowRight stepped ${after.time - before.time}s, x ${before.x} -> ${after.x}`,
  );
}

/** Undo and redo the second key, then reload and read the keys back. */
async function checkUndoAndReload({ page, shot, evidence, failures }) {
  const atMiddle = evidence.seeks[1];
  // Undo takes the second keyframe away, redo brings it back.
  await page.click('button[aria-label="Undo"]');
  await waitForScript(/keyframes: \{ "0%": \{ x: 0, y: 0 \} \}, duration: 4/, "the undo");
  evidence.undoDiamonds = await waitForDiamonds(page, 1);
  await page.click('button[aria-label="Redo"]');
  await waitForScript(new RegExp(`"100%": \\{ x: ${DX}, y: 0 \\}`), "the redo");
  evidence.redoDiamonds = await waitForDiamonds(page, 2);

  // A reload reads the keys back from the file.
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitReady(page);
  evidence.reloadDiamonds = await waitForDiamonds(page, 2);
  evidence.reloadSeek = await seekRuler(page, 1);
  check(
    failures,
    near(evidence.reloadSeek.x, atMiddle.x, 2),
    `after reload x at 1s is ${evidence.reloadSeek.x}, before ${atMiddle.x}`,
  );
  await shot("2-reloaded");
}

/** The export draws the box where the preview did. */
async function checkExport(gate) {
  const { evidence, failures } = gate;
  // The export draws the box where the preview did.
  const jobId = await exportWithHeaderButton({
    ...gate,
    origin: new URL(STUDIO_URL).origin,
    projectId: PROJECT_ID,
    renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 240_000),
  });
  const output = join(RENDERS_DIR, `${jobId}.mp4`);
  evidence.exportBox = evidence.seeks.map(({ time, x }) => ({
    time,
    previewLeft: BOX_LEFT + x,
    exportLeft: redLeftEdge(output, time),
  }));
  for (const frame of evidence.exportBox) {
    check(
      failures,
      near(frame.exportLeft, frame.previewLeft, 3),
      `export at ${frame.time}s has the box at ${frame.exportLeft}px, preview ${frame.previewLeft}px`,
    );
  }
}

/** The preview cannot reach a CDN here, so the fixture loads GSAP from its own assets. */
function copyGsap() {
  const dist = dirname(createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js"));
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  for (const file of ["gsap.min.js", "MotionPathPlugin.min.js"]) {
    copyFileSync(join(dist, file), join(projectDir, "assets", file));
  }
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

async function waitReady(page) {
  await page.waitForSelector('button[aria-label="Play"]:not([disabled])', { timeout: 60_000 });
  await page.waitForFunction(
    () =>
      document.querySelector("hyperframes-player")?.shadowRoot?.querySelector("iframe")
        ?.contentWindow?.gsap,
    { timeout: 60_000 },
  );
}

/** The preview's time, play state and the box's x, read from its runtime. */
function readPreview(page) {
  return page.evaluate(() => {
    const win = document
      .querySelector("hyperframes-player")
      .shadowRoot.querySelector("iframe").contentWindow;
    const box = win.document.getElementById("box");
    return {
      time: win.__player.getTime(),
      playing: win.__player.isPlaying(),
      x: Math.round(Number(win.gsap.getProperty(box, "x")) * 100) / 100,
    };
  });
}

function waitForPreview(page, accept, timeoutMs = 10_000) {
  return pollFor(() => readPreview(page), accept, timeoutMs, 50);
}

/** The box's centre in page pixels, and the preview's scale. */
function boxCentre(page) {
  return page.evaluate(() => {
    const frame = document.querySelector("hyperframes-player").shadowRoot.querySelector("iframe");
    const r = frame.getBoundingClientRect();
    const b = frame.contentDocument.getElementById("box").getBoundingClientRect();
    const scale = r.width / frame.contentDocument.documentElement.clientWidth;
    return { x: r.x + (b.x + b.width / 2) * scale, y: r.y + (b.y + b.height / 2) * scale, scale };
  });
}

async function selectBox(page) {
  const centre = await boxCentre(page);
  await page.mouse.click(centre.x, centre.y);
  await page.waitForSelector("[data-dom-edit-selection-box]", { timeout: 10_000 });
}

/** Drag the box `dx` composition pixels to the right on the canvas. */
async function dragBox(page, dx) {
  const { x, y, scale } = await boxCentre(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const part of [0.25, 0.5, 0.75, 1]) await page.mouse.move(x + dx * scale * part, y);
  await page.mouse.up();
}

/** Click the ruler at `time` seconds and return what the preview shows there. */
async function seekRuler(page, time) {
  const clip = await clipBox(page, "box");
  const rulerY = await page.$eval(
    "[data-timeline-grid-cell]",
    (el) => el.getBoundingClientRect().y,
  );
  // The box clip spans the whole 4s composition.
  await page.mouse.click(clip.x + (time / 4) * clip.width + 1, rulerY + 6);
  return waitForPreview(page, (s) => !s.playing && near(s.time, time, 1.5 / FPS));
}

/** Play for `ms` of wall time (from `from` when given), sampling the preview. */
async function playFor(page, ms, from) {
  if (from !== undefined) await seekRuler(page, from);
  await page.click('button[aria-label="Play"]');
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < ms) {
    samples.push({ wall: Date.now() - started, ...(await readPreview(page)) });
    await new Promise((r) => setTimeout(r, 100));
  }
  return { samples };
}

/** Pause, then check the time and the box stay put for half a second. */
async function pauseAndHold(page) {
  await page.click('button[aria-label="Pause"]');
  const first = await waitForPreview(page, (s) => !s.playing);
  await new Promise((r) => setTimeout(r, 500));
  const later = await readPreview(page);
  return { first, later, held: !later.playing && later.time === first.time && later.x === first.x };
}

/**
 * Over the playing samples, media time advances at `rate` × wall time (within 20%) and the box
 * never moves backwards while the time runs forward.
 */
function checkPlayback({ samples }, rate, failures, label) {
  const playing = samples.filter((s) => s.playing);
  const [first, last] = [playing[0], playing.at(-1)];
  const measured = first && last ? (last.time - first.time) / ((last.wall - first.wall) / 1000) : 0;
  check(
    failures,
    Math.abs(measured / rate - 1) <= 0.2,
    `${label} played at ${measured.toFixed(2)}x (${playing.length} samples)`,
  );
  const backwards = playing.slice(1).filter((s, i) => s.x < playing[i].x - 0.01);
  check(failures, backwards.length === 0, `${label}: the box moved backwards while playing`);
  const moved = playing.some((s) => s.x > 1);
  check(failures, moved, `${label}: the box never left its first keyframe`);
}

async function setSpeed(page, label) {
  await page.click('button[aria-label="Playback speed"]');
  const item = await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('[role="menuitemradio"]')].find(
        (el) => el.textContent.trim() === text,
      ),
    { timeout: 10_000 },
    label,
  );
  await item.asElement().click();
}

/** The timeline's keyframe diamonds ("position keyframe at 2s"), not the toolbar's button. */
function diamonds(page) {
  return page.$$eval('button[aria-label*="keyframe at"]', (buttons) =>
    buttons
      .map((b) => b.getAttribute("aria-label"))
      .filter((label) => /keyframe at [\d.]+s$/.test(label)),
  );
}

async function waitForDiamonds(page, count) {
  const shown = await pollFor(
    () => diamonds(page),
    (labels) => labels.length === count,
    15_000,
  );
  if (shown.length !== count)
    throw new Error(`expected ${count} diamonds: ${JSON.stringify(shown)}`);
  return shown;
}

async function waitForScript(pattern, what, timeoutMs = 15_000) {
  const html = await pollFor(readScript, (text) => pattern.test(text), timeoutMs);
  if (!pattern.test(html)) throw new Error(`${what} never saved: ${firstScript(html)}`);
  return html.match(/tl\.to\("#box"[^\n]*/)?.[0];
}

function firstScript(html) {
  return html.match(/<script>[\s\S]*?<\/script>/)?.[0];
}

/** Read until `accept` holds or `timeoutMs` passes, and return the last reading. */
async function pollFor(read, accept, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await read();
  }
  return value;
}

/** The left edge of the red box in the export's frame at `time`, in composition pixels. */
function redLeftEdge(file, time) {
  const r = spawnSync(
    "ffmpeg",
    [
      ...["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1"],
      ...["-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const [width, row] = [640, 180];
  const pixels = r.stdout.subarray(row * width * 3, (row + 1) * width * 3);
  const isRed = (x) => pixels[x * 3] > 180 && pixels[x * 3 + 1] < 80 && pixels[x * 3 + 2] < 80;
  const left = Array.from({ length: width }, (_, x) => x).find(isRed);
  return left ?? -BOX_SIZE;
}
