// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { resetAssetMediaInfoCache } from "../../utils/assetMediaInfo";
import { AssetMediaFacts } from "./AssetMediaFacts";

beforeEach(() => resetAssetMediaInfoCache());
afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

async function render(answer: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => answer),
  );
  const host = mountHost(<AssetMediaFacts projectId="p" asset="clip.mp4" />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

it("shows the probed facts on one line, with the full text as a tooltip", async () => {
  const host = await render(
    Response.json({
      metadata: {
        kind: "video",
        color: { codecName: "h264" },
        width: 640,
        height: 360,
        frameRate: 30,
        hasAudio: false,
      },
    }),
  );
  const facts = host.querySelector('[data-testid="asset-media-facts"]');
  expect(facts?.textContent).toBe("640×360 · 30 fps · H.264 · No audio");
  expect(facts?.getAttribute("title")).toBe("640×360 · 30 fps · H.264 · No audio");
});

it("shows nothing when the probe cannot tell", async () => {
  const host = await render(
    Response.json({ metadata: { kind: "video", probeError: "ffprobe unavailable" } }),
  );
  expect(host.querySelector('[data-testid="asset-media-facts"]')).toBeNull();
});

it("shows nothing when the server fails", async () => {
  const host = await render(new Response("boom", { status: 500 }));
  expect(host.querySelector('[data-testid="asset-media-facts"]')).toBeNull();
});
