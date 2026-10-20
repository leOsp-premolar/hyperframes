#!/usr/bin/env node
// The whole editing loop on an empty project, through the real UI: import a clip, place it on the
// timeline, split it, trim it, undo and redo, reload, export, then check the exported file itself.
// The project is reset from fixtures/editor-workflow on every run, so the gate can be rerun as is.
//
//   bun run dev -- --port 5316 --strictPort
//   STUDIO_URL="http://localhost:5316/#project/editor-workflow" node tests/e2e/editor-workflow.mjs
import {
  RENDERS_DIR,
  runEditWorkflow,
  runStudioGate,
  studioGateSetup,
} from "./editorWorkflowSteps.mjs";

const PROJECT_ID = "editor-workflow";
const STUDIO_URL = process.env.STUDIO_URL;
const projectDir = studioGateSetup(STUDIO_URL, PROJECT_ID);

await runStudioGate({ studioUrl: STUDIO_URL, outDir: process.env.OUT_DIR }, (gate) =>
  runEditWorkflow({
    ...gate,
    origin: new URL(STUDIO_URL).origin,
    projectId: PROJECT_ID,
    projectDir,
    rendersDir: RENDERS_DIR,
    frameSize: { width: 640, height: 360 },
    renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 240_000),
  }),
);
