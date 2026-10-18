#!/usr/bin/env node
// Slip and roll through the real UI on two cuts of one source touching at 2s. Y arms slip: a
// drag on clip a moves its in-point, not the clip; Undo puts it back. U arms roll: a drag on the
// cut moves a's end and b's start together, b's in-point following. The export then shows each
// clip's new source frames on either side of the moved cut.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/slip-roll" node tests/e2e/slip-roll.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RENDERS_DIR,
  check,
  exportWithHeaderButton,
  ffmpeg,
  framePsnr,
  runStudioGate,
  studioGateSetup,
} from "./editorWorkflowSteps.mjs";
import { hoverClipEndEdge } from "./timelineGestures.mjs";

const PROJECT_ID = "slip-roll";
const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);
const SOURCE = join(projectDir, "assets", "source.mp4");
const FPS = 30;

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const { page, shot, evidence, failures } = gate;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  ffmpeg(
    ...["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=${FPS}:duration=8`],
    ...["-pix_fmt", "yuv420p", SOURCE],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(clipSelector("b"), { timeout: 60_000 });
    const pps = await pixelsPerSecond(page);

    // Slip: a's window stays at 0-2s while its in-point moves 1s -> 0.5s.
    await page.keyboard.press("y");
    evidence.slipTool = await toolLabel(page);
    await dragClipBody(page, "a", 0.5 * pps);
    evidence.slipped = await waitForClip("a", (c) => c["data-media-start"] === "0.5");
    check(
      failures,
      evidence.slipped.start === "0" && evidence.slipped.duration === "2",
      `slip moved the clip: ${JSON.stringify(evidence.slipped)}`,
    );
    await page.click('button[aria-label="Undo"]');
    evidence.slipUndone = await waitForClip("a", (c) => c["data-media-start"] === "1");
    evidence.undoToast = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[role="status"], [role="alert"]')]
            .map((el) => el.textContent ?? "")
            .find((text) => text.includes("Undid")),
        { timeout: 10_000 },
      )
      .then((handle) => handle.jsonValue());
    check(failures, evidence.undoToast.includes("Slip clip"), `undo said "${evidence.undoToast}"`);
    await shot("1-slip-undone");

    // Roll: the cut moves 2s -> 2.5s; b starts later and its in-point follows, 4s -> 4.5s.
    await page.keyboard.press("u");
    evidence.rollTool = await toolLabel(page);
    await dragEdge(page, "a", 0.5 * pps);
    evidence.rolledB = await waitForClip("b", (c) => c["data-start"] === "2.5");
    evidence.rolledA = readClip("a");
    check(
      failures,
      evidence.rolledA.duration === "2.5",
      `a lasts ${evidence.rolledA.duration}s after the roll`,
    );
    check(
      failures,
      evidence.rolledB.duration === "1.5" && evidence.rolledB["data-media-start"] === "4.5",
      `b after the roll: ${JSON.stringify(evidence.rolledB)}`,
    );
    await shot("2-rolled");
    await page.keyboard.press("Escape");

    // The export: a plays source 1s+t up to 2.5s, then b plays source 4.5s on.
    const jobId = await exportWithHeaderButton({
      ...gate,
      origin: new URL(STUDIO_URL).origin,
      projectId: PROJECT_ID,
      renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 240_000),
    });
    const output = join(RENDERS_DIR, `${jobId}.mp4`);
    evidence.frames = [
      exportFrameMatches(output, 2.2, 3.2, failures),
      exportFrameMatches(output, 2.7, 4.7, failures),
    ];
  } finally {
    evidence.pageErrors = pageErrors;
    check(failures, pageErrors.length === 0, `the page threw: ${pageErrors.join(" | ")}`);
  }
});

function clipSelector(id) {
  return `.timeline-clip[data-el-id$="#${id}"]`;
}

async function clipBox(page, id) {
  return page.$eval(clipSelector(id), (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

async function pixelsPerSecond(page) {
  const box = await clipBox(page, "a");
  return box.width / 2;
}

function toolLabel(page) {
  return page.$eval('[aria-label^="Timeline tool:"]', (el) => el.getAttribute("aria-label"));
}

async function dragFrom(page, x, y, dx) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const part of [0.25, 0.5, 0.75, 1]) await page.mouse.move(x + dx * part, y);
  await page.mouse.up();
}

/** Press the middle of a clip, away from its trim handles, and drag. */
async function dragClipBody(page, id, dx) {
  const box = await clipBox(page, id);
  await dragFrom(page, box.x + box.width / 2, box.y + box.height / 2, dx);
}

async function dragEdge(page, id, dx) {
  const box = await clipBox(page, id);
  const { edgeX, midY } = await hoverClipEndEdge(page, clipSelector(id), box);
  await dragFrom(page, edgeX, midY, dx);
}

/** A clip's timing attributes as saved in index.html. */
function readClip(id) {
  const html = readFileSync(join(projectDir, "index.html"), "utf8");
  const tag = html.match(new RegExp(`<video[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? "";
  const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  return {
    start: attr("data-start"),
    duration: attr("data-duration"),
    "data-start": attr("data-start"),
    "data-media-start": attr("data-media-start"),
  };
}

async function waitForClip(id, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let clip = readClip(id);
  while (!predicate(clip)) {
    if (Date.now() > deadline)
      throw new Error(`${id} never saved as expected: ${JSON.stringify(clip)}`);
    await new Promise((r) => setTimeout(r, 200));
    clip = readClip(id);
  }
  return clip;
}

/** Export frame `t` must match the source at `sourceT` better than the frames beside it. */
function exportFrameMatches(output, t, sourceT, failures) {
  const scores = [-2, -1, 0, 1, 2].map((k) => ({
    offset: k,
    psnr: framePsnr(output, t, SOURCE, sourceT + k / FPS),
  }));
  const best = scores.reduce((a, b) => (b.psnr > a.psnr ? b : a));
  check(
    failures,
    best.offset === 0,
    `export ${t}s matches source ${sourceT + best.offset / FPS}s, not ${sourceT}s`,
  );
  return { t, sourceT, scores };
}
