// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMissingMedia, mediaKindOfPath, silenceDeclaredAudio } from "./missingMedia";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "hf-missing-media-"));
  mkdirSync(join(project, "assets"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(join(project, "assets", "here.mp4"), "video");
});
afterEach(() => {
  chmodSync(project, 0o755);
  rmSync(project, { recursive: true, force: true });
});

const write = (path: string, html: string) => writeFileSync(join(project, path), html);

describe("findMissingMedia", () => {
  it("lists each file the compositions name that is not there, with the clips that use it", () => {
    write(
      "index.html",
      `<div data-composition-id="main">
        <video id="hero" class="clip" src="assets/gone.mp4" data-start="2" data-duration="4"
          data-media-start="1.5" data-playback-rate="2" data-has-audio="true"></video>
        <video id="ok" class="clip" src="assets/here.mp4" data-start="0" data-duration="2"></video>
        <img id="logo" class="clip" src="assets/logo.png" data-start="0" data-duration="3">
        <audio id="music" class="clip" src="assets/song.mp3" data-start="0" data-duration="9"></audio>
        <video src="https://example.com/remote.mp4"></video>
        <img src="data:image/png;base64,AAAA">
        <!-- <img src="assets/commented.png"> -->
      </div>`,
    );
    const missing = findMissingMedia(project);
    expect(missing.map(({ path, kind, reason }) => [path, kind, reason])).toEqual([
      ["assets/gone.mp4", "video", "missing"],
      ["assets/logo.png", "image", "missing"],
      ["assets/song.mp3", "audio", "missing"],
    ]);
    expect(missing[0]?.references).toEqual([
      {
        file: "index.html",
        tag: "video",
        id: "hero",
        start: 2,
        duration: 4,
        mediaStart: 1.5,
        playbackRate: 2,
        declaresAudio: true,
      },
    ]);
  });

  it("resolves a nested composition's ../ paths from its own folder", () => {
    write("index.html", `<div data-composition-id="main"></div>`);
    write(
      "compositions/intro.html",
      `<template><video id="a" src="../assets/gone.mp4" muted></video>
        <video id="b" src="../assets/here.mp4"></video></template>`,
    );
    const missing = findMissingMedia(project);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      path: "assets/gone.mp4",
      references: [{ file: "compositions/intro.html", id: "a", declaresAudio: false }],
    });
  });

  it("gathers every clip that names the same file, across compositions", () => {
    write("index.html", `<video id="a" src="assets/gone.mp4" data-has-audio="false"></video>`);
    write(
      "compositions/b.html",
      `<video data-hf-id="hf-b" src="../assets/gone.mp4" data-has-audio="true"></video>`,
    );
    const [entry] = findMissingMedia(project);
    expect(entry?.references.map((ref) => [ref.file, ref.id, ref.declaresAudio])).toEqual([
      ["compositions/b.html", "hf-b", true],
      ["index.html", "a", false],
    ]);
  });

  it("reads a <source> as its video's clip and names a folder that stands where a file should", () => {
    mkdirSync(join(project, "assets", "folder.mp4"));
    write(
      "index.html",
      `<video id="v" data-start="1" data-duration="2"><source src="assets/folder.mp4"></video>`,
    );
    const [entry] = findMissingMedia(project);
    expect(entry).toMatchObject({
      path: "assets/folder.mp4",
      reason: "not-a-file",
      references: [{ tag: "source", id: "v", start: 1, duration: 2 }],
    });
  });

  it.skipIf(process.getuid?.() === 0)("names a file it cannot read", () => {
    writeFileSync(join(project, "assets", "locked.mp4"), "video");
    chmodSync(join(project, "assets", "locked.mp4"), 0o000);
    write("index.html", `<video src="assets/locked.mp4"></video>`);
    expect(findMissingMedia(project)[0]).toMatchObject({ reason: "unreadable" });
  });

  it("skips placeholders, render output and dependencies", () => {
    mkdirSync(join(project, "renders"));
    mkdirSync(join(project, "node_modules"));
    write("renders/old.html", `<video src="assets/gone.mp4"></video>`);
    write("node_modules/x.html", `<video src="assets/gone.mp4"></video>`);
    write("index.html", '<video src="${asset}"></video><img src="{{logo}}">');
    expect(findMissingMedia(project)).toEqual([]);
  });

  it("decodes encoded names, so a file named with spaces is found", () => {
    writeFileSync(join(project, "assets", "my clip.mp4"), "video");
    write(
      "index.html",
      `<video src="assets/my%20clip.mp4"></video><video src="assets/my&#32;clip.mp4">`,
    );
    expect(findMissingMedia(project)).toEqual([]);
  });
});

describe("mediaKindOfPath", () => {
  it.each([
    ["a.MP4", "video"],
    ["a.webp", "image"],
    ["a.flac", "audio"],
    ["a.woff2", null],
    ["a", null],
  ])("%s is %s", (path, kind) => {
    expect(mediaKindOfPath(path)).toBe(kind);
  });
});

describe("silenceDeclaredAudio", () => {
  it("marks silent only the videos that play the file and said they had sound", () => {
    const html = `<video id="a" src="../assets/here.mp4" data-has-audio='true' data-start="1"></video>
<video id="b" src="../assets/other.mp4" data-has-audio="true"></video>
<video id="c" data-has-audio="true"><source src="../assets/here.mp4"></video>
<video id="d" src="../assets/here.mp4" data-has-audio="false"></video>
<audio id="e" src="../assets/here.mp4" data-has-audio="true"></audio>`;
    expect(silenceDeclaredAudio(project, "compositions/x.html", html, "assets/here.mp4")).toBe(
      `<video id="a" src="../assets/here.mp4" data-has-audio="false" data-start="1"></video>
<video id="b" src="../assets/other.mp4" data-has-audio="true"></video>
<video id="c" data-has-audio="false"><source src="../assets/here.mp4"></video>
<video id="d" src="../assets/here.mp4" data-has-audio="false"></video>
<audio id="e" src="../assets/here.mp4" data-has-audio="true"></audio>`,
    );
  });
});
