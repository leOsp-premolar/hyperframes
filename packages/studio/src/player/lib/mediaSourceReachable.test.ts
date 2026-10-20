import { afterEach, expect, it, vi } from "vitest";
import { mediaSourceReachable } from "./mediaSourceReachable";

afterEach(() => vi.unstubAllGlobals());

it("asks for one byte and answers whether the file is there", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response("x", { status: 206 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await mediaSourceReachable("/a.mp4")).toBe(true);
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Range: "bytes=0-0" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("gone", { status: 404 })),
  );
  expect(await mediaSourceReachable("/a.mp4")).toBe(false);
});

it("treats a failed request as unreachable, but lets a cancellation through", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(new TypeError("offline"))),
  );
  expect(await mediaSourceReachable("/a.mp4")).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(mediaSourceReachable("/a.mp4", controller.signal)).rejects.toThrow("offline");
});

it("treats an HTML page answering for a missing file as unreachable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    ),
  );
  expect(await mediaSourceReachable("/assets/missing.mov")).toBe(false);
});
