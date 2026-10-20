#!/usr/bin/env node
// Track lock and solo through the real UI. The padlock saves data-timeline-locked on the music
// track's clip; a drag, a trim and a Delete of that clip, and a move of another clip onto the
// track, are then refused and the file stays as it was. Unlocking (and undoing a lock) frees it again. Solo on the voice track silences the
// music in the preview only: the runtime holds it at volume 0, the file never carries the mark,
// and the export still has the music.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/track-lock-solo" node tests/e2e/track-lock-solo.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RENDERS_DIR,
  check,
  exportWithHeaderButton,
  ffmpeg,
  meanVolume,
  runStudioGate,
  studioGateSetup,
} from "./editorWorkflowSteps.mjs";
import { clipBox, clipSelector, dragClipBody } from "./timelineGestures.mjs";

const PROJECT_ID = "track-lock-solo";
const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);
const INDEX = join(projectDir, "index.html");
const SOLO_ATTR = "data-hf-solo-silenced";
const readIndex = () => readFileSync(INDEX, "utf8");
const musicTag = () => readIndex().match(/<audio[^>]*\sid="music"[^>]*>/)?.[0] ?? "";

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  const { page, shot, evidence, failures } = gate;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    join(projectDir, "assets/music.wav"),
  );
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    "4",
    join(projectDir, "assets/voice.wav"),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(clipSelector("music"), { timeout: 60_000 });
    const pps = (await clipBox(page, "music")).width / 3;
    // Rows are numbered top-down as the header shows them; find each by its clip's row.
    const LOCK = await rowButton(page, "music", "Lock track");
    const UNLOCK = LOCK.replace("Lock", "Unlock");
    const SOLO = await rowButton(page, "voice", "Solo track");
    const UNSOLO = SOLO.replace("Solo", "Unsolo");
    evidence.rowButtons = { LOCK, SOLO };

    // Lock: one attribute on the track's clip, one undo entry.
    await page.click(`button[aria-label="${LOCK}"]`);
    evidence.lockedTag = await waitForIndex(() => /data-timeline-locked/.test(musicTag()), "lock");
    await page.waitForSelector(`button[aria-label="${UNLOCK}"][aria-pressed="true"]`);
    const lockedFile = readIndex();
    await shot("1-locked");

    // A drag is refused with the lock's reason; the trim handle never mounts.
    await dragClipBody(page, "music", 0.5 * pps);
    evidence.dragToast = await toastText(page, "locked");
    const box = await clipBox(page, "music");
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 400));
    evidence.trimHandle = await page.$$eval(`${clipSelector("music")} div`, (divs) =>
      divs.some((d) => d.style.cursor === "col-resize"),
    );
    check(failures, !evidence.trimHandle, "a locked clip offered a trim handle");
    // Delete of the selected clip is refused too.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press("Delete");
    await new Promise((r) => setTimeout(r, 1500));
    // Nor can another track's clip be moved onto it.
    const voiceBox = await clipBox(page, "voice");
    await dragClipBody(page, "voice", 0, box.y - voiceBox.y);
    await new Promise((r) => setTimeout(r, 1500));
    evidence.unchangedWhileLocked = readIndex() === lockedFile;
    evidence.voiceRowAfter = Math.round((await clipBox(page, "voice")).y - voiceBox.y);
    check(failures, evidence.voiceRowAfter === 0, "the refused move left the voice on another row");
    check(failures, evidence.unchangedWhileLocked, "an edit of the locked track reached the file");
    check(
      failures,
      (await page.$(clipSelector("music"))) !== null,
      "the locked clip left the timeline",
    );

    // Unlock with the padlock; lock again and undo it: both free the clip.
    await page.click(`button[aria-label="${UNLOCK}"]`);
    await waitForIndex(() => !/data-timeline-locked/.test(musicTag()), "unlock");
    await page.click(`button[aria-label="${LOCK}"]`);
    await waitForIndex(() => /data-timeline-locked/.test(musicTag()), "relock");
    await page.click('button[aria-label="Undo"]');
    await waitForIndex(() => !/data-timeline-locked/.test(musicTag()), "undo of the lock");
    evidence.undoToast = await toastText(page, "Undid");
    check(failures, evidence.undoToast.includes(LOCK), `undo said "${evidence.undoToast}"`);
    await page.waitForSelector(`button[aria-label="${LOCK}"][aria-pressed="false"]`);
    await dragClipBody(page, "music", 0.5 * pps);
    evidence.movedTag = await waitForIndex(
      () => /\sdata-start="0\.5"/.test(musicTag()),
      "the move after unlocking",
    ).then(musicTag);
    await shot("2-unlocked-moved");

    // Solo the voice: the music is silent in the preview only.
    await page.click(`button[aria-label="${SOLO}"]`);
    evidence.soloPreview = await page
      .waitForFunction(
        (attr) => {
          const doc = document
            .querySelector("hyperframes-player")
            ?.shadowRoot?.querySelector("iframe")?.contentDocument;
          const music = doc?.getElementById("music");
          const voice = doc?.getElementById("voice");
          if (!music?.hasAttribute(attr) || voice?.hasAttribute(attr)) return null;
          return { musicMarked: true, voiceMarked: false };
        },
        { timeout: 15_000 },
        SOLO_ATTR,
      )
      .then((handle) => handle.jsonValue());
    // The runtime applies volumes while it plays: the music is held at 0, the voice is not.
    evidence.soloVolumes = await playAndRead(
      page,
      ({ music, voice }) => music.volume === 0 && voice.volume > 0,
    );
    await shot("3-soloed");
    check(failures, !readIndex().includes(SOLO_ATTR), "the solo mark reached the file");

    // The export ignores the solo: the music is there.
    const jobId = await exportWithHeaderButton({
      ...gate,
      origin: new URL(STUDIO_URL).origin,
      projectId: PROJECT_ID,
      renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 240_000),
    });
    evidence.exportDb = meanVolume(join(RENDERS_DIR, `${jobId}.mp4`), 1, 1.5);
    check(failures, evidence.exportDb > -30, `the export's music is ${evidence.exportDb} dB`);

    // Unsolo restores the music in the preview.
    await page.click(`button[aria-label="${UNSOLO}"]`);
    evidence.unsoloed = await playAndRead(page, ({ music }) => music.volume > 0 && !music.marked);
  } finally {
    evidence.pageErrors = pageErrors;
    check(failures, pageErrors.length === 0, `the page threw: ${pageErrors.join(" | ")}`);
  }
});

/** The aria-label of the header button starting with `prefix` on the row of clip `id`. */
async function rowButton(page, id, prefix) {
  const box = await clipBox(page, id);
  const label = await page.$$eval(
    "button[aria-label]",
    (buttons, { prefix, top, bottom }) =>
      buttons
        .filter((b) => b.getAttribute("aria-label").startsWith(prefix))
        .find((b) => {
          const r = b.getBoundingClientRect();
          const mid = r.y + r.height / 2;
          return mid >= top && mid <= bottom;
        })
        ?.getAttribute("aria-label"),
    { prefix, top: box.y, bottom: box.y + box.height },
  );
  if (!label) throw new Error(`no "${prefix}" button on the ${id} row`);
  return label;
}

/** The preview's music and voice: volume, media time and the solo mark. */
function readSound(page) {
  return page.evaluate((attr) => {
    const doc = document
      .querySelector("hyperframes-player")
      ?.shadowRoot?.querySelector("iframe")?.contentDocument;
    const read = (id) => {
      const el = doc?.getElementById(id);
      // The element comes from the iframe's realm, so `instanceof HTMLMediaElement` is false.
      return el && "volume" in el
        ? { volume: el.volume, time: el.currentTime, marked: el.hasAttribute(attr) }
        : null;
    };
    return { music: read("music"), voice: read("voice") };
  }, SOLO_ATTR);
}

/** Whether the music has played a little and `accept` holds for what the preview reads. */
function heard(sound, accept) {
  return Boolean(sound.music && sound.voice && sound.music.time > 0.2 && accept(sound));
}

/**
 * Play from the start until `heard` holds, then pause. Volumes are only applied while the
 * runtime plays.
 */
async function playAndRead(page, accept) {
  await page.waitForSelector('button[aria-label="Play"]:not([disabled])', { timeout: 30_000 });
  await page.keyboard.press("Home");
  await page.click('button[aria-label="Play"]');
  const deadline = Date.now() + 15_000;
  let sound = await readSound(page);
  try {
    while (!heard(sound, accept) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      sound = await readSound(page);
    }
  } finally {
    await page.click('button[aria-label="Pause"]').catch(() => {});
  }
  if (!heard(sound, accept)) {
    throw new Error(`the preview never read as expected: ${JSON.stringify(sound)}`);
  }
  return sound;
}

function toastText(page, includes) {
  return page
    .waitForFunction(
      (text) =>
        [...document.querySelectorAll('[role="status"], [role="alert"]')]
          .map((el) => el.textContent ?? "")
          .find((t) => t.includes(text)),
      { timeout: 10_000 },
      includes,
    )
    .then((handle) => handle.jsonValue());
}

async function waitForIndex(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(readIndex())) {
    if (Date.now() > deadline) throw new Error(`${what} never saved: ${musicTag()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return musicTag();
}
