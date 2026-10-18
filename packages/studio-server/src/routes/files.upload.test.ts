// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { registerFileRoutes } from "./files";
import { stubAdapter } from "./stubAdapter.test-helpers";

const media = mkdtempSync(join(tmpdir(), "hf-upload-media-"));
let project: string;

beforeAll(() => {
  if (!findFfBinary("ffmpeg")) return;
  const ffmpeg = (...args: string[]) =>
    spawnSync(findFfBinary("ffmpeg") ?? "ffmpeg", ["-v", "error", "-y", ...args]);
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=64x48", "-frames:v", "1", join(media, "still.png"));
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x48:duration=0.5",
    "-pix_fmt",
    "yuv420p",
    join(media, "clip.mp4"),
  );
  writeFileSync(join(media, "broken.png"), readFileSync(join(media, "still.png")).subarray(0, 100));
  writeFileSync(join(media, "broken.mp4"), Buffer.alloc(4000, 0x5a));
});
afterAll(() => rmSync(media, { recursive: true, force: true }));

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "hf-upload-project-"));
  writeFileSync(join(project, "index.html"), "<html>index</html>");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function upload(names: string[], query = "") {
  const api = new Hono();
  registerFileRoutes(api, stubAdapter(project));
  const form = new FormData();
  for (const name of names) {
    const bytes = name === "notes.txt" ? Buffer.from("hello") : readFileSync(join(media, name));
    form.append("file", new File([bytes], name));
  }
  return api.request(`http://localhost/projects/demo/upload${query}`, {
    method: "POST",
    body: form,
  });
}

const projectFiles = () => readdirSync(project).sort();

describe.skipIf(!findFfBinary("ffmpeg") || !findFfBinary("ffprobe"))("POST /upload", () => {
  it("adds the good files of a batch and names why each other one was refused", async () => {
    const res = await upload(["clip.mp4", "broken.png", "broken.mp4", "notes.txt"], "?mediaOnly=1");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.files).toEqual(["clip.mp4"]);
    expect(body.invalid).toEqual([
      { name: "broken.png", reason: "could not be read: the file is damaged or is not really PNG" },
      { name: "broken.mp4", reason: "could not be read: the file is damaged or is not really MP4" },
      { name: "notes.txt", reason: expect.stringContaining(".txt files can't be imported") },
    ]);
    expect(projectFiles()).toEqual(["clip.mp4", "index.html"]);
  });

  it("leaves the project as it was when every file is refused, even with a folder asked for", async () => {
    const before = readFileSync(join(project, "index.html"), "utf8");
    const res = await upload(["broken.png", "notes.txt"], "?mediaOnly=1&dir=assets");
    expect(res.status).toBe(201);
    expect((await res.json()).files).toEqual([]);
    expect(projectFiles()).toEqual(["index.html"]);
    expect(readFileSync(join(project, "index.html"), "utf8")).toBe(before);
  });

  it("creates the folder once a file is accepted", async () => {
    const res = await upload(["still.png", "broken.png"], "?mediaOnly=1&dir=assets");
    expect((await res.json()).files).toEqual(["assets/still.png"]);
    expect(readdirSync(join(project, "assets"))).toEqual(["still.png"]);
  });

  it("keeps accepting any file type outside the media import, as the file tree uploads", async () => {
    const res = await upload(["notes.txt", "still.png"]);
    expect((await res.json()).files).toEqual(["notes.txt", "still.png"]);
  });

  it("still refuses damaged media outside the media import", async () => {
    const res = await upload(["broken.mp4"]);
    expect((await res.json()).invalid).toHaveLength(1);
    expect(projectFiles()).toEqual(["index.html"]);
  });
});
