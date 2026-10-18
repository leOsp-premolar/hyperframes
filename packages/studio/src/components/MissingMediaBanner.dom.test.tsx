// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupMounted, mountHost } from "./ui/mountHost.testHelpers";
import { useMissingMediaStore, type MissingMediaEntry } from "../utils/missingMedia";
import { MissingMediaBanner } from "./MissingMediaBanner";

afterEach(() => {
  cleanupMounted();
  act(() => useMissingMediaStore.getState().set([], null));
});

const entry = (path: string, extra: Partial<MissingMediaEntry> = {}): MissingMediaEntry => ({
  path,
  kind: "video",
  reason: "missing",
  clipIds: [],
  uses: 1,
  ...extra,
});

function show(missing: MissingMediaEntry[], replace: ((path: string) => void) | null = vi.fn()) {
  act(() => useMissingMediaStore.getState().set(missing, replace));
  return mountHost(<MissingMediaBanner />);
}

const rows = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("li")).map((li) => li.textContent);

it("shows nothing while every file plays", () => {
  expect(show([]).querySelector('[data-testid="missing-media-banner"]')).toBeNull();
});

it("names each file, why it can't play and how many clips use it", () => {
  const host = show([
    entry("assets/a.mov", { uses: 2 }),
    entry("assets/b.png", { reason: "unreadable", kind: "image" }),
    entry("assets/c", { reason: "not-a-file" }),
  ]);
  expect(host.textContent).toContain("3 media files can't be played");
  expect(rows(host)).toEqual([
    "assets/a.movis missing, used by 2 clipsReplace…",
    "assets/b.pngcan't be read, used by 1 clipReplace…",
    "assets/cis a folder, not a file, used by 1 clipReplace…",
  ]);
});

it("opens the picker for the file whose Replace was pressed", () => {
  const replace = vi.fn();
  const host = show([entry("assets/a.mov"), entry("assets/b.mov")], replace);
  const button = host.querySelector('[data-missing-path="assets/b.mov"] button');
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(replace).toHaveBeenCalledWith("assets/b.mov");
});

it("lists three and points to the clip badges for the rest", () => {
  const host = show(["a", "b", "c", "d", "e"].map((name) => entry(`assets/${name}.mp4`)));
  expect(rows(host)).toHaveLength(3);
  expect(host.textContent).toContain("2 more; right-click a clip marked Missing");
});

it("hides until the list changes", () => {
  const host = show([entry("assets/a.mov")]);
  const hide = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Hide");
  act(() => hide?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(host.querySelector('[data-testid="missing-media-banner"]')).toBeNull();
  act(() =>
    useMissingMediaStore.getState().set([entry("assets/a.mov"), entry("assets/b.mov")], vi.fn()),
  );
  expect(host.querySelector('[data-testid="missing-media-banner"]')).not.toBeNull();
});

it("disables Replace until Studio can take a file", () => {
  const host = show([entry("assets/a.mov")], null);
  expect(host.querySelector<HTMLButtonElement>("li button")?.disabled).toBe(true);
});
