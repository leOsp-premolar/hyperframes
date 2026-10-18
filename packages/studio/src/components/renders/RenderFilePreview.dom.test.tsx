// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { RenderThumbnail } from "./RenderFilePreview";

afterEach(cleanupMounted);

const show = (filename: string, status: "complete" | "failed" = "complete") =>
  mountHost(<RenderThumbnail job={{ filename, status }} src={`/r/${filename}`} hovered={false} />);

it("plays a GIF as itself", () => {
  expect(show("a.gif").querySelector("img")?.getAttribute("src")).toBe("/r/a.gif");
});

it.each([
  ["a.wav", "audio", "WAV"],
  ["a.mp3", "audio", "MP3"],
  ["a.zip", "frames", "PNG"],
])("names %s as %s", (filename, kind, label) => {
  const host = show(filename);
  expect(host.querySelector("[data-render-kind]")?.getAttribute("data-render-kind")).toBe(kind);
  expect(host.textContent).toBe(label);
});

it("shows only a state dot for an unfinished render", () => {
  const host = show("a.wav", "failed");
  expect(host.querySelector("[data-render-kind]")).toBeNull();
  expect(host.querySelector(".bg-danger-ink")).not.toBeNull();
});
