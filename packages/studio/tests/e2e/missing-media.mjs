#!/usr/bin/env node
// Missing media through the real UI: a project whose two files are gone opens without errors and
// names them; cancelling the picker, a file of the wrong type and a damaged file each leave the
// project as it was; a good image takes the missing name, a video in another container is relinked
// from the clip menu with every other clip setting kept; the export then plays the new video from
// the clip's own source offset.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/missing-media" node tests/e2e/missing-media.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const PROJECT_ID = "missing-media";
const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);
const indexHtml = () => readFileSync(join(projectDir, "index.html"), "utf8");
const original = indexHtml();
// The fixture's hero clip starts 0.5s into its source.
const MEDIA_START_S = 0.5;

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const { page, sourcePath, shot, evidence, failures } = gate;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const workDir = mkdtempSync(join(tmpdir(), "hf-missing-media-"));
  const files = makeFiles(workDir);
  const unchanged = (step) => {
    check(failures, indexHtml() === original, `${step} changed index.html`);
    check(failures, !existsSync(join(projectDir, "assets")), `${step} left files in assets/`);
  };
  try {
    // 1. Both files are named, and both clips are marked.
    evidence.listed = await waitForRows(page, 2);
    await waitForBadges(page, 2);
    await shot("1-missing");
    check(
      failures,
      JSON.stringify(evidence.listed) === JSON.stringify(["assets/hero.mov", "assets/logo.png"]),
      `the banner lists ${JSON.stringify(evidence.listed)}`,
    );

    // 2. Cancelling the picker changes nothing.
    const chooser = await openPicker(page, () => clickReplace(page, "assets/logo.png"));
    evidence.pickerAccept = await pickerAccept(page);
    check(
      failures,
      evidence.pickerAccept.includes(".png") && !evidence.pickerAccept.includes(".mp4"),
      `the picker for an image offers ${evidence.pickerAccept}`,
    );
    await chooser.cancel();
    await new Promise((r) => setTimeout(r, 1000));
    unchanged("cancelling");
    check(failures, (await waitForRows(page, 2)).length === 2, "cancelling changed the banner");

    // 3. A file of another type, then a damaged one, are refused with the reason.
    for (const [name, reason] of [
      ["tone.wav", "tone.wav is audio, but assets/logo.png is used as an image"],
      ["broken.png", "broken.png could not be read: the file is damaged or is not really PNG"],
    ]) {
      const picker = await openPicker(page, () => clickReplace(page, "assets/logo.png"));
      await picker.accept([files[name]]);
      evidence[`refused ${name}`] = await waitForToast(page, reason);
      unchanged(`refusing ${name}`);
    }

    // 4. A good image takes the missing file's own name: no composition changes.
    const logoPicker = await openPicker(page, () => clickReplace(page, "assets/logo.png"));
    await logoPicker.accept([files["logo.png"]]);
    evidence.logoReplaced = await waitForToast(page, "Replaced assets/logo.png.");
    check(failures, indexHtml() === original, "replacing the logo changed index.html");
    check(
      failures,
      readFileSync(join(projectDir, "assets/logo.png")).equals(readFileSync(files["logo.png"])),
      "assets/logo.png is not the chosen file",
    );
    evidence.afterLogo = await waitForRows(page, 1);
    await waitForBadges(page, 1);

    // 5. The hero clip's menu relinks it to an MP4; only the file name changes in the composition.
    const heroPicker = await openPicker(page, () => replaceFromClipMenu(page, "hero"));
    await heroPicker.accept([sourcePath]);
    evidence.heroReplaced = await waitForToast(
      page,
      "Replaced assets/hero.mov with assets/hero.mp4.",
    );
    check(
      failures,
      indexHtml() === original.replace('src="assets/hero.mov"', 'src="assets/hero.mp4"'),
      "relinking the hero clip changed more than its src",
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="missing-media-banner"]'),
      { timeout: 20_000 },
    );
    await waitForBadges(page, 0);
    evidence.preview = await previewMedia(page);
    check(failures, evidence.preview.heroReady, "the preview did not load the relinked video");
    check(failures, evidence.preview.logoLoaded, "the preview did not load the replaced image");
    await shot("2-replaced");

    // 6. The export plays the new file from the clip's own offset: frame t is source t + 0.5s.
    const jobId = await exportWithHeaderButton({
      ...gate,
      origin: new URL(STUDIO_URL).origin,
      projectId: PROJECT_ID,
      renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 240_000),
    });
    checkExport(join(RENDERS_DIR, `${jobId}.mp4`), sourcePath, evidence, failures);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    evidence.pageErrors = pageErrors;
    check(failures, pageErrors.length === 0, `the page threw: ${pageErrors.join(" | ")}`);
  }
});

function makeFiles(dir) {
  const path = (name) => join(dir, name);
  ffmpeg("-f", "lavfi", "-i", "color=c=orange:size=100x50", "-frames:v", "1", path("logo.png"));
  ffmpeg("-f", "lavfi", "-i", "sine=duration=1", path("tone.wav"));
  writeFileSync(path("broken.png"), readFileSync(path("logo.png")).subarray(0, 60));
  return Object.fromEntries(["logo.png", "tone.wav", "broken.png"].map((n) => [n, path(n)]));
}

async function pickerAccept(page) {
  return page.$eval('[data-testid="missing-media-file-input"]', (input) => input.accept);
}

async function openPicker(page, action) {
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), action()]);
  return chooser;
}

async function waitForRows(page, n) {
  const handle = await page.waitForFunction(
    (count) => {
      const rows = [...document.querySelectorAll("[data-missing-path]")];
      return rows.length === count && rows.map((row) => row.dataset.missingPath);
    },
    { timeout: 30_000 },
    n,
  );
  return handle.jsonValue();
}

function waitForBadges(page, n) {
  return page.waitForFunction(
    (count) => document.querySelectorAll('[data-badge="missing"]').length === count,
    { timeout: 30_000 },
    n,
  );
}

async function clickReplace(page, path) {
  await page.click(`[data-missing-path="${path}"] button`);
}

async function replaceFromClipMenu(page, clipId) {
  await page.click(`.timeline-clip[data-el-id$="#${clipId}"]`, { button: "right" });
  const item = await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
        el.textContent.includes("Replace media"),
      ),
    { timeout: 10_000 },
  );
  await item.asElement().click();
}

async function waitForToast(page, text) {
  const handle = await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll('[role="alert"], [role="status"]')]
        .map((el) => el.textContent ?? "")
        .find((msg) => msg.includes(t)),
    { timeout: 30_000 },
    text,
  );
  return handle.jsonValue();
}

/** The hero video and logo image of whichever frame holds them, or null; a detached frame answers nothing. */
async function readPreview(frame) {
  try {
    return await frame.evaluate(() => {
      const hero = document.querySelector("video#hero");
      const logo = document.querySelector("img#logo");
      if (!hero || !logo) return null;
      return {
        heroSrc: hero.currentSrc,
        heroReady: hero.readyState >= 2,
        logoLoaded: logo.complete && logo.naturalWidth === 100,
      };
    });
  } catch {
    return null;
  }
}

function previewReady(state) {
  return Boolean(state.heroReady && state.logoLoaded);
}

async function findPreview(page) {
  const states = await Promise.all(page.frames().map(readPreview));
  return states.find(Boolean) ?? { heroReady: false, logoLoaded: false };
}

/** Whether the preview iframe's hero video and logo image loaded their new files. */
async function previewMedia(page) {
  const deadline = Date.now() + 20_000;
  let state = await findPreview(page);
  while (!previewReady(state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    state = await findPreview(page);
  }
  return state;
}

function checkExport(outputPath, sourcePath, evidence, failures) {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath],
    { encoding: "utf8" },
  );
  const duration = Number(probe.stdout.trim());
  evidence.exportDuration = duration;
  check(failures, Math.abs(duration - 3) <= 1 / 30, `the export lasts ${duration}s, not 3s`);
  evidence.frames = [];
  for (const t of [0.5, 1.5, 2.5]) {
    const matched = framePsnr(outputPath, t, sourcePath, t + MEDIA_START_S);
    const unshifted = framePsnr(outputPath, t, sourcePath, t);
    evidence.frames.push({ t, matched, unshifted });
    check(
      failures,
      matched > unshifted,
      `export frame ${t}s matches source ${t}s better than ${t + MEDIA_START_S}s`,
    );
  }
}
