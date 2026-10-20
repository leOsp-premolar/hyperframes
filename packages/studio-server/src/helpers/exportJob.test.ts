// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderJobState, StudioApiAdapter } from "../types";
import { renderMetaPath, startExportJob } from "./exportJob";
import type { FfRunner } from "./exportFinish";
import { planExport } from "./exportPlan";

let renders: string;
let inner: RenderJobState;
let started: Parameters<StudioApiAdapter["startRender"]>[0] | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  renders = mkdtempSync(join(tmpdir(), "hf-export-job-"));
  started = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(renders, { recursive: true, force: true });
});

const adapter = {
  startRender: (opts) => {
    started = opts;
    inner = { id: opts.jobId, status: "rendering", progress: 0, outputPath: opts.outputPath };
    return inner;
  },
} as Pick<StudioApiAdapter, "startRender">;

const options = (name: string) => ({
  project: { id: "p", dir: renders },
  outputPath: join(renders, name),
  format: "mp4" as const,
  fps: { num: 30, den: 1 },
  quality: "standard",
  jobId: name.replace(/\..*$/, ""),
});

// Stands in for ffmpeg: writes the output the command names last.
const writesOutput: FfRunner = async (tool, args) => {
  if (tool === "ffprobe") return JSON.stringify({ streams: [{ codec_type: "audio" }] });
  writeFileSync(args.at(-1) ?? "", "exported");
  return "";
};

/** Let the producer finish, then run the poll and the finishing step. */
async function producerEnds(status: RenderJobState["status"], error?: string) {
  if (status === "complete") writeFileSync(inner.outputPath, "rendered");
  inner.status = status;
  inner.progress = 100;
  if (error) inner.error = error;
  await vi.advanceTimersByTimeAsync(250);
}

describe("startExportJob", () => {
  it("hands a plan that needs no finishing to the adapter as it is", () => {
    const job = startExportJob(
      adapter as StudioApiAdapter,
      options("a.mp4"),
      planExport("mp4", null),
      30,
    );
    expect(job).toBe(inner);
    expect(started?.outputPath).toBe(join(renders, "a.mp4"));
  });

  it("asks the producer to stop at the out point", () => {
    startExportJob(
      adapter as StudioApiAdapter,
      options("a.gif"),
      planExport("gif", { start: 0, end: 2 }),
      30,
    );
    expect(started).toMatchObject({ format: "gif", endSeconds: 2 });
  });

  it("renders into .work, stays rendering through the finish, then completes with the export alone", async () => {
    const job = startExportJob(
      adapter as StudioApiAdapter,
      options("b.wav"),
      planExport("wav", { start: 1, end: 2 }),
      30,
      writesOutput,
    );
    expect(started?.outputPath).toBe(join(renders, ".work", "b.mp4"));
    expect(started?.format).toBe("mp4");
    inner.progress = 50;
    await vi.advanceTimersByTimeAsync(250);
    expect(job).toMatchObject({ status: "rendering", progress: 47 });
    await producerEnds("complete");
    expect(job).toMatchObject({ status: "complete", progress: 100 });
    expect(readFileSync(join(renders, "b.wav"), "utf8")).toBe("exported");
    expect(JSON.parse(readFileSync(join(renders, "b.meta.json"), "utf8")).status).toBe("complete");
    expect(readdirSync(join(renders, ".work"))).toEqual([]);
  });

  it("reports the producer's failure and leaves no export", async () => {
    const job = startExportJob(
      adapter as StudioApiAdapter,
      options("c.mp3"),
      planExport("mp3", null),
      30,
      writesOutput,
    );
    await producerEnds("failed", "browser crashed");
    expect(job).toMatchObject({ status: "failed", error: "browser crashed" });
    expect(existsSync(join(renders, "c.mp3"))).toBe(false);
    expect(JSON.parse(readFileSync(join(renders, "c.meta.json"), "utf8")).status).toBe("failed");
  });

  it("reports a finishing failure the same way", async () => {
    const failing: FfRunner = async () => {
      throw new Error("ffmpeg failed: no space");
    };
    const job = startExportJob(
      adapter as StudioApiAdapter,
      options("d.m4a"),
      planExport("m4a", null),
      30,
      failing,
    );
    await producerEnds("complete");
    expect(job).toMatchObject({ status: "failed", error: "ffmpeg failed: no space" });
    expect(existsSync(join(renders, "d.m4a"))).toBe(false);
    expect(readdirSync(join(renders, ".work"))).toEqual([]);
  });

  it("cancels the producer and keeps nothing", async () => {
    const cancel = vi.fn();
    const job = startExportJob(
      { startRender: (opts) => ({ ...adapter.startRender(opts), cancel }) } as StudioApiAdapter,
      options("e.zip"),
      planExport("png-sequence", null),
      30,
      writesOutput,
    );
    mkdirSync(started?.outputPath ?? "", { recursive: true });
    job.cancel?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(cancel).toHaveBeenCalled();
    expect(job.status).toBe("cancelled");
    expect(readdirSync(join(renders, ".work"))).toEqual([]);
  });
});

describe("renderMetaPath", () => {
  it.each([
    ["/r/a.mp4", "/r/a.meta.json"],
    ["/r/a.gif", "/r/a.meta.json"],
    ["/r/a.wav", "/r/a.meta.json"],
    ["/r/a.zip", "/r/a.meta.json"],
    ["/r/.work/a", "/r/.work/a.meta.json"],
  ])("puts %s's status at %s", (output, meta) => {
    expect(renderMetaPath(output)).toBe(meta);
  });
});
