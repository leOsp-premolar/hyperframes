// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { useMissingMediaStore } from "../utils/missingMedia";
import { useMissingMedia } from "./useMissingMedia";

const MISSING = {
  missing: [{ path: "assets/a.mov", kind: "video", reason: "missing", references: [{ id: "a" }] }],
};

let fetchMock: ReturnType<typeof vi.fn>;
const showToast = vi.fn();
const onReplaced = vi.fn();

function Harness() {
  useMissingMedia({ projectId: "p", refreshKey: 0, showToast, onReplaced });
  return null;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

function answer(replace: Response) {
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith("/media/missing") ? Response.json(MISSING) : replace,
  );
  vi.stubGlobal("fetch", fetchMock);
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

async function pick(file: File | null) {
  act(() => useMissingMediaStore.getState().replace?.("assets/a.mov"));
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="missing-media-file-input"]',
  );
  expect(input?.accept).toContain(".mp4");
  if (!input) return;
  if (file) {
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
  } else {
    input.dispatchEvent(new Event("cancel"));
  }
  await flush();
}

beforeEach(() => {
  showToast.mockReset();
  onReplaced.mockReset();
});
afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

it("publishes what is missing for the badges and the banner", async () => {
  answer(new Response(null, { status: 500 }));
  mountHost(<Harness />);
  await flush();
  expect(useMissingMediaStore.getState().missing.map((entry) => entry.path)).toEqual([
    "assets/a.mov",
  ]);
});

it("changes nothing when the picker is cancelled", async () => {
  answer(new Response(null, { status: 500 }));
  mountHost(<Harness />);
  await flush();
  await pick(null);
  expect(posts()).toHaveLength(0);
  expect(showToast).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="missing-media-file-input"]')).toBeNull();
});

it("shows the server's reason for a refused file and does not reload", async () => {
  answer(Response.json({ error: "a.png is an image" }, { status: 400 }));
  mountHost(<Harness />);
  await flush();
  await pick(new File(["x"], "a.png"));
  expect(showToast).toHaveBeenCalledWith("a.png is an image");
  expect(onReplaced).not.toHaveBeenCalled();
});

it("reloads and checks again after a replacement, with its warnings", async () => {
  answer(Response.json({ path: "assets/a.mp4", warnings: ["No audio."] }, { status: 201 }));
  mountHost(<Harness />);
  await flush();
  const checksBefore = fetchMock.mock.calls.length;
  await pick(new File(["x"], "a.mp4"));
  expect(showToast).toHaveBeenCalledWith(
    "Replaced assets/a.mov with assets/a.mp4. No audio.",
    "info",
  );
  expect(onReplaced).toHaveBeenCalledTimes(1);
  // One POST, then one fresh /media/missing check.
  expect(fetchMock.mock.calls.length).toBe(checksBefore + 2);
});
