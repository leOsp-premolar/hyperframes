import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RenderJobState, StudioApiAdapter } from "../types.js";
import { finishExport, finishStage, type FfRunner } from "./exportFinish.js";
import type { ExportPlan } from "./exportPlan.js";

type StartRenderOptions = Parameters<StudioApiAdapter["startRender"]>[0];

/** The status sidecar beside a render: `<job>.meta.json` for a file or a frames folder. */
export function renderMetaPath(outputPath: string): string {
  return `${outputPath.replace(/\.(mp4|webm|mov|gif|zip|wav|mp3|m4a)$/, "")}.meta.json`;
}

// The producer's own output share of the progress bar; finishing takes the rest.
const RENDER_SHARE = 0.95;
const POLL_MS = 200;

function producerOutputPath(outputPath: string, plan: ExportPlan): string {
  const base = join(dirname(outputPath), ".work", outputPath.slice(dirname(outputPath).length + 1));
  const stem = base.slice(0, base.length - plan.ext.length);
  return plan.producerFormat === "png-sequence" ? stem : `${stem}.${plan.producerFormat}`;
}

function writeMeta(outputPath: string, meta: Record<string, unknown>): void {
  try {
    writeFileSync(renderMetaPath(outputPath), JSON.stringify(meta));
  } catch {
    // The listing treats a render without a sidecar as complete when its file is there.
  }
}

/**
 * Start `plan` through the adapter. A plan that needs no finishing is the adapter's job as is;
 * otherwise the producer renders into `renders/.work/`, and the returned job stays "rendering"
 * through the finishing step, reporting complete only once the export file is in place.
 */
export function startExportJob(
  adapter: StudioApiAdapter,
  options: StartRenderOptions,
  plan: ExportPlan,
  fps: number,
  run?: FfRunner,
): RenderJobState {
  const base = {
    ...options,
    format: plan.producerFormat,
    ...(plan.endSeconds !== undefined ? { endSeconds: plan.endSeconds } : {}),
  };
  if (!plan.needsFinish) return adapter.startRender(base);

  const work = producerOutputPath(options.outputPath, plan);
  mkdirSync(dirname(work), { recursive: true });
  const inner = adapter.startRender({ ...base, outputPath: work });
  const startedAt = Date.now();
  const job: RenderJobState = {
    id: options.jobId,
    status: "rendering",
    progress: 0,
    outputPath: options.outputPath,
    cancel: () => {
      job.status = "cancelled";
      inner.cancel?.();
    },
  };
  const cleanUp = () => {
    rmSync(work, { recursive: true, force: true });
    rmSync(renderMetaPath(work), { force: true });
  };
  const fail = (error: unknown) => {
    if (job.status === "rendering") {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      writeMeta(options.outputPath, { status: "failed" });
    }
    rmSync(options.outputPath, { force: true });
    cleanUp();
  };
  const finish = async () => {
    job.stage = finishStage(plan);
    await finishExport({ plan, work, output: options.outputPath, fps, run });
    if (job.status !== "rendering") {
      rmSync(options.outputPath, { force: true });
      cleanUp();
      return;
    }
    if (inner.audioLoweredDb !== undefined) job.audioLoweredDb = inner.audioLoweredDb;
    writeMeta(options.outputPath, {
      status: "complete",
      durationMs: Date.now() - startedAt,
      ...(inner.audioLoweredDb !== undefined ? { audioLoweredDb: inner.audioLoweredDb } : {}),
    });
    job.progress = 100;
    job.status = "complete";
    cleanUp();
  };
  const timer = setInterval(() => {
    if (job.status === "cancelled") {
      clearInterval(timer);
      cleanUp();
      return;
    }
    job.progress = Math.floor(inner.progress * RENDER_SHARE);
    if (inner.stage) job.stage = inner.stage;
    if (inner.status === "rendering") return;
    clearInterval(timer);
    if (inner.status === "complete") void finish().catch(fail);
    else if (inner.status === "cancelled") {
      job.status = "cancelled";
      cleanUp();
    } else fail(new Error(inner.error ?? `The render ${inner.status}`));
  }, POLL_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return job;
}
