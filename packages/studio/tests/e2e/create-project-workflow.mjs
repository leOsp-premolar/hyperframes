#!/usr/bin/env node
// A project made in Studio, not by the CLI, carries the whole editing loop. From an open project,
// "New project" refuses an unusable name and a taken one, then creates a 640x360 project and opens
// it; the new project must be lint-clean and network-free, then import, edit and export like the
// editor-workflow gate (the steps are shared, see editorWorkflowSteps.mjs).
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/editor-workflow" node tests/e2e/create-project-workflow.mjs
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECTS_DIR,
  RENDERS_DIR,
  check,
  runEditWorkflow,
  runStudioGate,
  studioGateSetup,
  waitForEmptyTimeline,
} from "./editorWorkflowSteps.mjs";

// The project Studio is opened on, and the one the gate creates from it.
const START_ID = "editor-workflow";
const NEW_NAME = "Create Workflow Gate";
const NEW_ID = "create-workflow-gate";
// The producer waits this long for a timeline a project without `data-no-timeline` never registers.
const TIMELINE_WAIT_S = 45;
const STUDIO_URL = process.env.STUDIO_URL;

const startDir = studioGateSetup(STUDIO_URL, START_ID);
const startHtml = readFileSync(join(startDir, "index.html"), "utf8");
// The gate's own project is created anew on every run.
const newDir = join(PROJECTS_DIR, NEW_ID);
rmSync(newDir, { recursive: true, force: true });
const origin = new URL(STUDIO_URL).origin;

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, async (gate) => {
  await openDialog(gate);
  await refuseUnusableName(gate);
  await refuseTakenName(gate);
  await createAndOpen(gate);
  await checkCreatedProject(gate);
  await runEditWorkflow({
    ...gate,
    origin,
    projectId: NEW_ID,
    projectDir: newDir,
    rendersDir: RENDERS_DIR,
    frameSize: { width: 640, height: 360 },
    renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 240_000),
  });
  check(
    gate.failures,
    gate.evidence.render.seconds < TIMELINE_WAIT_S,
    `the export took ${gate.evidence.render.seconds}s, as long as the timeline wait`,
  );
});

async function replaceText(page, selector, value) {
  await page.click(selector, { count: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

function submit(page) {
  return page.click('[role="dialog"] button[type="submit"]');
}

function alertText(page) {
  return page
    .waitForSelector('[role="dialog"] [role="alert"]', { timeout: 10_000 })
    .then((el) => el.evaluate((e) => e.textContent));
}

// 1. The header opens the dialog with the name field ready.
async function openDialog({ page, evidence, failures }) {
  await page.waitForSelector('button[aria-label="New project"]', { timeout: 60_000 });
  await page.click('button[aria-label="New project"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  evidence.focusedOnOpen = await page.evaluate(() => document.activeElement?.id);
  check(
    failures,
    evidence.focusedOnOpen === "new-project-name",
    `the dialog opened with ${evidence.focusedOnOpen} focused, not the name`,
  );
}

// 2. A name with nothing usable is refused and creates nothing.
async function refuseUnusableName({ page, evidence, failures }) {
  await replaceText(page, "#new-project-name", "!!!");
  await submit(page);
  evidence.unusableName = await alertText(page);
  check(
    failures,
    /letter or number/.test(evidence.unusableName),
    `an unusable name answered "${evidence.unusableName}"`,
  );
}

// 3. A taken name is refused, offers the existing project, and leaves it untouched.
async function refuseTakenName({ page, shot, evidence, failures }) {
  await replaceText(page, "#new-project-name", "Editor  Workflow!");
  await submit(page);
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes("exists"),
    { timeout: 10_000 },
  );
  evidence.takenName = await alertText(page);
  evidence.offersOpenExisting = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] [role="alert"] button')].some(
      (b) => b.textContent === "Open it",
    ),
  );
  check(failures, evidence.offersOpenExisting, "a taken name did not offer to open it");
  check(
    failures,
    readFileSync(join(startDir, "index.html"), "utf8") === startHtml,
    "asking for a taken name changed the existing project",
  );
  await shot("0-taken-name");
}

// 4. A custom 640x360, 6 s project is created and opened in place.
async function createAndOpen({ page, evidence, failures }) {
  await replaceText(page, "#new-project-name", NEW_NAME);
  await page.select("#new-project-resolution", "custom");
  await replaceText(page, "#new-project-width", "640");
  await replaceText(page, "#new-project-height", "360");
  await replaceText(page, "#new-project-duration", "6");
  await submit(page);
  // Studio appends its view state to the hash (`#project/<id>?v=1&t=0…`) once the project opens.
  await page.waitForFunction(
    (id) => new RegExp(`^#project/${id}(\\?|$)`).test(window.location.hash),
    { timeout: 15_000 },
    NEW_ID,
  );
  await page.waitForFunction(
    (id) => [...document.querySelectorAll("span")].some((s) => s.textContent === id),
    { timeout: 30_000 },
    NEW_ID,
  );
  evidence.dialogClosed = (await page.$('[role="dialog"]')) === null;
  check(failures, evidence.dialogClosed, "the dialog stayed open after creating the project");
}

// 5. On disk: the starting files, sized as asked, with no network and no timeline wait.
function readCreatedProject() {
  const html = readFileSync(join(newDir, "index.html"), "utf8");
  const attr = (name) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return {
    files: ["index.html", "hyperframes.json"].filter((f) => existsSync(join(newDir, f))),
    size: [attr("data-width"), attr("data-height")],
    duration: attr("data-duration"),
    noTimeline: html.includes("data-no-timeline"),
    scripts: html.split("<script").length - 1,
  };
}

async function checkCreatedProject({ page, shot, evidence, failures }) {
  evidence.created = readCreatedProject();
  const expected = {
    files: ["index.html", "hyperframes.json"],
    size: ["640", "360"],
    duration: "6",
    noTimeline: true,
    scripts: 0,
  };
  check(
    failures,
    JSON.stringify(evidence.created) === JSON.stringify(expected),
    `the new project is ${JSON.stringify(evidence.created)}`,
  );
  const lint = await (await fetch(`${origin}/api/projects/${NEW_ID}/lint`)).json();
  evidence.lintFindings = lint.findings;
  check(
    failures,
    JSON.stringify(lint.findings) === "[]",
    `the new project has lint findings: ${JSON.stringify(lint.findings)}`,
  );
  await waitForEmptyTimeline(page);
  await shot("0-created");
}
