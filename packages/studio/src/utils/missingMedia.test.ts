import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clipMediaPath,
  missingMediaFor,
  parseMissingMedia,
  requestMediaReplacement,
  type MissingMediaEntry,
} from "./missingMedia";

const hero: MissingMediaEntry = {
  path: "assets/my clip.mov",
  kind: "video",
  reason: "missing",
  clipIds: ["hero"],
  uses: 2,
};

describe("parseMissingMedia", () => {
  it("keeps what the server reports and drops what it cannot read", () => {
    expect(
      parseMissingMedia({
        missing: [
          {
            path: "assets/my clip.mov",
            kind: "video",
            reason: "missing",
            references: [{ id: "hero" }, { id: null }],
          },
          { path: "x.cube", kind: "lut", reason: "missing", references: [] },
          { kind: "audio" },
        ],
      }),
    ).toEqual([hero]);
    expect(parseMissingMedia(null)).toEqual([]);
  });
});

describe("clipMediaPath", () => {
  it.each([
    ["http://localhost:5190/api/projects/p/preview/assets/my%20clip.mov", "assets/my clip.mov"],
    ["/api/projects/p/preview/assets/a.mp3?v=2#t=1", "assets/a.mp3"],
    ["assets/a.png", "assets/a.png"],
    ["/assets/bad%zz.png", "assets/bad%zz.png"],
  ])("%s plays %s", (src, path) => {
    expect(clipMediaPath({ src })).toBe(path);
  });

  it("is null for a clip without media", () => {
    expect(clipMediaPath({})).toBeNull();
  });
});

describe("missingMediaFor", () => {
  it("matches a clip by where it points, or else by its id", () => {
    const src = "/api/projects/p/preview/assets/my%20clip.mov";
    expect(missingMediaFor([hero], { id: "x", src })).toBe(hero);
    expect(missingMediaFor([hero], { id: "k", domId: "hero" })).toBe(hero);
    expect(missingMediaFor([hero], { id: "other", src: "/assets/b.mov" })).toBeNull();
    expect(missingMediaFor([], { id: "hero" })).toBeNull();
  });
});

describe("requestMediaReplacement", () => {
  afterEach(() => vi.unstubAllGlobals());
  const file = new File(["x"], "new.mp4");

  it("posts the file for the missing path and reads the result", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json(
        { ok: true, path: "assets/my clip.mp4", warnings: ["shorter", 3] },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestMediaReplacement("p", "assets/my clip.mov", file)).toEqual({
      ok: true,
      path: "assets/my clip.mp4",
      warnings: ["shorter"],
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects/p/media/replace?path=assets%2Fmy%20clip.mov");
    expect(init?.method).toBe("POST");
    const body = init?.body;
    expect(body instanceof FormData && body.get("file")).toBeInstanceOf(File);
  });

  it("passes on the server's reason for a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "new.png is an image" }, { status: 400 })),
    );
    expect(await requestMediaReplacement("p", "a.mov", file)).toEqual({
      ok: false,
      error: "new.png is an image",
    });
  });

  it("says so when the server cannot be reached or answers nothing useful", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(await requestMediaReplacement("p", "a.mov", file)).toMatchObject({
      ok: false,
      error: expect.stringContaining("did not answer"),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 502 })),
    );
    expect(await requestMediaReplacement("p", "a.mov", file)).toEqual({
      ok: false,
      error: "Could not replace a.mov (502)",
    });
  });
});
