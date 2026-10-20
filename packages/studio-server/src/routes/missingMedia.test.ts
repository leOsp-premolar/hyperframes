// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
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
import { replaceFileAtomically } from "@hyperframes/core/atomic-file";
import { probeMediaDetails } from "../helpers/mediaMetadata";
import { validateUploadedMediaBuffer } from "../helpers/mediaValidation";
import { registerMissingMediaRoutes, type ReplaceMediaTools } from "./missingMedia";
import { stubAdapter } from "./stubAdapter.test-helpers";
import { ffmpeg, hasFfTools } from "./ffmpegMedia.test-helpers";

const media = mkdtempSync(join(tmpdir(), "hf-replace-media-"));
let project: string;

beforeAll(() => {
  if (!hasFfTools) return;
  const picture = ["-f", "lavfi", "-i", "testsrc2=size=64x48:duration=1", "-pix_fmt", "yuv420p"];
  ffmpeg(...picture, join(media, "silent.mp4"));
  ffmpeg(
    ...[
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x48:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=1",
    ],
    ...["-pix_fmt", "yuv420p", "-shortest", join(media, "voiced.mp4")],
  );
  ffmpeg(...picture, join(media, "silent.webm"));
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=64x48", "-frames:v", "1", join(media, "still.png"));
  ffmpeg("-f", "lavfi", "-i", "sine=duration=1", join(media, "tone.mp3"));
  writeFileSync(join(media, "broken.mp4"), Buffer.alloc(4000, 0x5a));
});
afterAll(() => rmSync(media, { recursive: true, force: true }));

const INDEX = `<div data-composition-id="main" data-width="64" data-height="48">
  <video id="hero" class="clip" src="assets/hero.mov" data-start="1" data-duration="3"
    data-media-start="0.5" data-track-index="2" data-has-audio="true"
    style="transform: scale(1.5)"></video>
  <audio id="music" class="clip" src="assets/song.mp3" data-start="0" data-duration="0.5"
    data-volume="0.4"></audio>
</div>`;
const NESTED = `<template><video id="intro-clip" class="clip" src="../assets/hero.mov"></video></template>`;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "hf-replace-project-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(join(project, "index.html"), INDEX);
  writeFileSync(join(project, "compositions", "intro.html"), NESTED);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const realTools: ReplaceMediaTools = {
  validate: validateUploadedMediaBuffer,
  probe: probeMediaDetails,
  writeText: replaceFileAtomically,
};

function api(tools: ReplaceMediaTools = realTools) {
  const app = new Hono();
  registerMissingMediaRoutes(app, stubAdapter(project), tools);
  return app;
}

function replace(path: string, name: string, tools?: ReplaceMediaTools, as = name) {
  const form = new FormData();
  form.append("file", new File([readFileSync(join(media, name))], as));
  return api(tools).request(
    `http://localhost/projects/demo/media/replace?path=${encodeURIComponent(path)}`,
    { method: "POST", body: form },
  );
}

const read = (path: string) => readFileSync(join(project, path), "utf8");
const snapshot = () => ({
  index: read("index.html"),
  intro: read("compositions/intro.html"),
  // .hyperframes/ holds the backups taken before each write, which outlive a rollback by design.
  files: readdirSync(project)
    .filter((name) => name !== ".hyperframes")
    .sort(),
});

describe("GET /media/missing", () => {
  it("lists the missing files and the clips that use them", async () => {
    const res = await api().request("http://localhost/projects/demo/media/missing");
    const body = await res.json();
    expect(body.missing.map((entry: { path: string }) => entry.path)).toEqual([
      "assets/hero.mov",
      "assets/song.mp3",
    ]);
    expect(body.missing[0].references.map((ref: { id: string }) => ref.id)).toEqual([
      "intro-clip",
      "hero",
    ]);
  });
});

describe.skipIf(!hasFfTools)("POST /media/replace", () => {
  it("puts a file of the same type under the missing name, changing no composition", async () => {
    const before = snapshot();
    const res = await replace("assets/song.mp3", "tone.mp3");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      path: "assets/song.mp3",
      updatedReferences: [],
      warnings: [],
    });
    expect(read("index.html")).toBe(before.index);
    expect(readFileSync(join(project, "assets/song.mp3"))).toEqual(
      readFileSync(join(media, "tone.mp3")),
    );
  });

  it("relinks every clip to a file of another container, keeping each clip's settings", async () => {
    const res = await replace("assets/hero.mov", "silent.mp4");
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.path).toBe("assets/hero.mp4");
    expect(body.updatedReferences.sort()).toEqual(["compositions/intro.html", "index.html"]);
    // The file name, and the sound the silent file cannot give: export needs the two to agree.
    expect(read("index.html")).toBe(
      INDEX.replace("assets/hero.mov", "assets/hero.mp4").replace(
        'data-has-audio="true"',
        'data-has-audio="false"',
      ),
    );
    expect(read("compositions/intro.html")).toBe(NESTED.replace("hero.mov", "hero.mp4"));
    // The clip asks for 0.5s + 3s of source from a 1s file, and said it had sound.
    expect(body.warnings).toEqual([
      expect.stringContaining('"hero" plays the source up to 3.5s, but the new file is 1s long'),
      expect.stringContaining('"hero" is now marked silent: the new file has no audio track'),
    ]);
  });

  it("keeps a clip's sound when the new video has an audio track", async () => {
    const res = await replace("assets/hero.mov", "voiced.mp4");
    expect((await res.json()).warnings).toEqual([expect.stringContaining("plays the source up")]);
    expect(read("index.html")).toContain('data-has-audio="true"');
  });

  it("never overwrites a file that is already there: it takes the next free name", async () => {
    mkdirSync(join(project, "assets"));
    writeFileSync(join(project, "assets", "hero.mp4"), "someone else's file");
    const res = await replace("assets/hero.mov", "silent.mp4");
    expect((await res.json()).path).toBe("assets/hero-2.mp4");
    expect(read("assets/hero.mp4")).toBe("someone else's file");
    expect(read("index.html")).toContain('src="assets/hero-2.mp4"');
  });

  it.each([
    [
      "an image for a video",
      "assets/hero.mov",
      "still.png",
      400,
      /still\.png is an image, but assets\/hero\.mov is used as video\. Choose a MP4/,
    ],
    ["audio for a video", "assets/hero.mov", "tone.mp3", 400, /tone\.mp3 is audio/],
    [
      "a damaged file",
      "assets/hero.mov",
      "broken.mp4",
      422,
      /broken\.mp4 could not be read: the file is damaged or is not really MP4/,
    ],
    ["a file nothing is missing", "index.html", "silent.mp4", 409, /index\.html is not missing/],
    ["a path no clip uses", "assets/other.mp4", "silent.mp4", 409, /is not missing/],
  ])("refuses %s and changes nothing", async (_case, path, name, status, message) => {
    const before = snapshot();
    const res = await replace(path, name);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toMatch(message);
    expect(snapshot()).toEqual(before);
  });

  it("refuses a file type Studio cannot import", async () => {
    const res = await replace("assets/hero.mov", "silent.mp4", realTools, "notes.txt");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.txt files can't be imported/);
  });

  it("asks for a file when none was sent", async () => {
    const res = await api().request("http://localhost/projects/demo/media/replace?path=x.mp4", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
  });

  it("puts back the compositions already rewritten and removes the new file when a write fails", async () => {
    const before = snapshot();
    let writes = 0;
    const failing: ReplaceMediaTools = {
      ...realTools,
      writeText: (file, text, mode) => {
        if (++writes === 2) throw new Error("disk full");
        replaceFileAtomically(file, text, mode);
      },
    };
    const res = await replace("assets/hero.mov", "silent.webm", failing);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/disk full; nothing was changed/);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(project, "assets"))).toBe(false);
  });

  it("undoes the relink when a reference survives the rewrite", async () => {
    // A script-built src is a spelling the rewrite cannot know: the scan still finds the old name.
    const before = snapshot();
    const keepOld: ReplaceMediaTools = { ...realTools, writeText: () => undefined };
    const res = await replace("assets/hero.mov", "silent.mp4", keepOld);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/could not be updated; nothing was changed/);
    expect(snapshot()).toEqual(before);
  });
});
