import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { isValidProjectId } from "./src/utils/projectRouting";
import { createStudioApi, type ProjectHistory } from "@hyperframes/studio-server";
import type { ViteDevServer } from "vite";
import {
  createProjectFolder,
  createProjectSignatureCache,
  createViteAdapter,
} from "./vite.adapter";

import { previewChangeOwner } from "./vite.preview-watch";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hf-project-routing-"));
  roots.push(root);
  const data = join(root, "data");
  const sessions = join(root, "sessions");
  mkdirSync(data);
  mkdirSync(sessions);
  // Project resolution does not call Vite's module loader.
  const adapter = createViteAdapter(
    data,
    {} as ViteDevServer,
    createProjectSignatureCache({ compute: () => "test" }),
    { historyRoot: join(root, "history") },
  );
  const app = createStudioApi(adapter);
  return { root, data, sessions, adapter, app };
}

describe("Studio's dev server keeps each project's history", () => {
  it("serves it, so an edit Studio claims is the next undo, and opens it once per project", async () => {
    const { data, adapter, app } = fixture();
    mkdirSync(join(data, "demo"));
    writeFileSync(join(data, "demo", "index.html"), "A");
    const project = adapter.resolveProject("demo")!;
    const history = await adapter.history!(project);
    expect(await adapter.history!(project)).toBe(history);
    try {
      writeFileSync(join(data, "demo", "index.html"), "B");
      const claim = await app.request("http://localhost/projects/demo/history/claim", {
        method: "POST",
        body: JSON.stringify({ label: "Moved Title", paths: ["index.html"] }),
      });
      expect(await claim.json()).toMatchObject({ claimed: { id: expect.any(String) } });
      const list = await app.request("http://localhost/projects/demo/history");
      expect(await list.json()).toMatchObject({ back: { label: "Moved Title" } });
    } finally {
      await history?.close();
    }
  });

  it("opens a new project's own history once it takes the folder's path", async () => {
    const { data, adapter, app } = fixture();
    mkdirSync(join(data, "demo"));
    writeFileSync(join(data, "demo", "index.html"), "A");
    const old = await adapter.history!(adapter.resolveProject("demo")!);
    renameSync(join(data, "demo"), join(data, "demo-moved"));
    mkdirSync(join(data, "demo"));
    writeFileSync(join(data, "demo", "index.html"), "new");

    const list = await app.request("http://localhost/projects/demo/history");
    expect(list.status).toBe(200);
    expect(existsSync(join(data, "demo", ".hyperframes", "history-id"))).toBe(true);
    const fresh = await adapter.history!(adapter.resolveProject("demo")!);
    expect(fresh?.projectId).not.toBe(old?.projectId);
    await fresh?.close();
  });
});

describe("Studio's dev server retries a history whose folder changed while it opened", () => {
  it("opens it again on the next request", async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-project-history-retry-"));
    roots.push(root);
    mkdirSync(join(root, "demo"));
    const history = { replacedAtPath: () => false } as unknown as ProjectHistory;
    const openHistory = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("now another project"), { name: "HistoryClosedError" }),
      )
      .mockResolvedValue(history);
    const adapter = createViteAdapter(
      root,
      {} as ViteDevServer,
      createProjectSignatureCache({ compute: () => "test" }),
      { openHistory },
    );
    expect(await adapter.history!(adapter.resolveProject("demo")!)).toBeNull();
    expect(await adapter.history!(adapter.resolveProject("demo")!)).toBe(history);
  });
});

describe("Studio's dev server closes the histories it opened when it stops", () => {
  it("closes each through the opener it was given, so an open edit keeps its label", async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-project-history-close-"));
    roots.push(root);
    mkdirSync(join(root, "demo"));
    const httpServer = new EventEmitter();
    const close = vi.fn(async () => {});
    const openHistory = vi.fn(
      async () => ({ close, replacedAtPath: () => false }) as unknown as ProjectHistory,
    );
    const adapter = createViteAdapter(
      root,
      { httpServer } as unknown as ViteDevServer,
      createProjectSignatureCache({ compute: () => "test" }),
      { openHistory },
    );
    await adapter.history!(adapter.resolveProject("demo")!);
    httpServer.emit("close");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(openHistory).toHaveBeenCalledOnce();
  });
});

describe("Vite project resolution boundary", () => {
  it.each(["C%3A", "C%3Ademo", "..%2Fsessions", "a%2Fb", "a%5Cb", "%2E%2E%2Fsessions", "a%00b"])(
    "rejects a router-decoded unsafe ID: %s",
    async (id) => {
      const { app } = fixture();
      expect((await app.request(`http://localhost/projects/${id}`)).status).toBe(404);
    },
  );

  it("preserves valid names, session aliases, and explicitly listed symlink projects", async () => {
    const { data, sessions, root, adapter, app } = fixture();
    const id = "..Mañana #1 50%";
    mkdirSync(join(data, id));
    expect((await app.request(`http://localhost/projects/${encodeURIComponent(id)}`)).status).toBe(
      200,
    );
    writeFileSync(join(sessions, "alias.json"), JSON.stringify({ projectId: id, title: "Title" }));
    expect(adapter.resolveProject("alias")?.id).toBe(id);
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(linked, join(data, "shortcut"), "junction");
    expect(adapter.resolveProject("shortcut")?.dir).toBe(realpathSync(linked));
  });

  it("rejects drive-relative IDs that Windows resolves as root or sibling aliases", () => {
    expect(win32.resolve("C:\\hf\\data", "C:")).toBe("C:\\hf\\data");
    expect(win32.resolve("C:\\hf\\data", "C:demo")).toBe("C:\\hf\\data\\demo");
    expect(isValidProjectId("C:")).toBe(false);
    expect(isValidProjectId("C:demo")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not discover POSIX directory names outside the portable ID contract",
    async () => {
      const { data, adapter } = fixture();
      for (const id of ["valid", "bad\\name", "bad\nname", "C:demo"]) {
        mkdirSync(join(data, id));
        writeFileSync(join(data, id, "index.html"), "<html></html>");
      }
      expect((await adapter.listProjects()).map((project) => project.id)).toEqual(["valid"]);
    },
  );

  it("opens a folder named with a colon, which Windows would read as a file stream and refuses", () => {
    const { data, sessions, adapter } = fixture();
    const id = "Customer story: Northwind";
    mkdirSync(join(data, "demo"));
    if (process.platform !== "win32") {
      mkdirSync(join(data, id));
      expect(adapter.resolveProject(id)?.id).toBe(id);
    }
    writeFileSync(join(sessions, "alias.json"), JSON.stringify({ projectId: id }));
    writeFileSync(
      join(sessions, "stream.json"),
      JSON.stringify({ projectId: "demo::$INDEX_ALLOCATION" }),
    );
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(adapter.resolveProject(id)).toBeNull();
      expect(adapter.resolveProject("demo::$INDEX_ALLOCATION")).toBeNull();
      expect(adapter.resolveProject("alias")).toBeNull();
      expect(adapter.resolveProject("stream")).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("rejects traversal in a session's project mapping", () => {
    const { sessions, adapter } = fixture();
    writeFileSync(join(sessions, "alias.json"), JSON.stringify({ projectId: "../sessions" }));
    expect(adapter.resolveProject("alias")).toBeNull();
  });
});

describe("dynamic preview ownership", () => {
  it.each([false, true])("registers a project opened after startup (symlink: %s)", (linked) => {
    const { root, data, sessions } = fixture();
    const owners = new Map<string, string>();
    const watched: string[] = [];
    const cache = createProjectSignatureCache({
      compute: () => "signature",
      watch: (dir) => {
        // Ownership must exist before newly watched files can emit events.
        expect(previewChangeOwner(owners, join(dir, "index.html"))?.projectId).toBe("new-project");
        watched.push(dir);
      },
    });
    const adapter = createViteAdapter(data, {} as ViteDevServer, cache, {
      onResolveProject: (project) => owners.set(project.dir, project.id),
    });
    expect(adapter.resolveProject("new-project")).toBeNull();
    expect(owners.size).toBe(0);
    const dir = linked ? join(root, "different-target-name") : join(data, "new-project");
    mkdirSync(dir);
    if (linked) symlinkSync(dir, join(data, "new-project"), "junction");
    writeFileSync(join(dir, "index.html"), "before");
    writeFileSync(join(sessions, "alias.json"), JSON.stringify({ projectId: "new-project" }));
    const project = adapter.resolveProject(linked ? "alias" : "new-project")!;
    cache.get(project.dir);
    writeFileSync(join(dir, "index.html"), "after");
    expect(watched).toEqual([realpathSync(dir)]);
    expect(previewChangeOwner(owners, join(realpathSync(dir), "index.html"))?.projectId).toBe(
      "new-project",
    );
  });
});

describe("Studio's dev server and the catalog", () => {
  it("answers every install with a 501 that points to hyperframes preview", async () => {
    const { data, app } = fixture();
    mkdirSync(join(data, "demo"));
    writeFileSync(join(data, "demo", "index.html"), "A");

    const response = await app.request("http://localhost/projects/demo/registry/install", {
      method: "POST",
      body: JSON.stringify({ blockName: "ai-chat-reveal" }),
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: "Installing catalog items needs hyperframes preview",
    });
  });
});

const FILES = { "index.html": "<html></html>", "hyperframes.json": "{}" };

describe("Studio's dev server creates projects", () => {
  it("creates one from the API, even before the projects folder exists, and serves it", async () => {
    const { data, app } = fixture();
    rmSync(data, { recursive: true });
    const res = await app.request("http://localhost/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Summer Trip", width: 1280, height: 720 }),
    });
    expect(res.status).toBe(201);
    expect(readFileSync(join(data, "summer-trip", "index.html"), "utf8")).toContain(
      'data-width="1280"',
    );
    const listed = await (await app.request("http://localhost/projects")).json();
    expect(listed).toMatchObject({ canCreateProjects: true, projects: [{ id: "summer-trip" }] });
    expect((await app.request("http://localhost/projects/summer-trip")).status).toBe(200);
  });

  it("answers 409 for a taken name and keeps the existing project as it was", async () => {
    const { data, app } = fixture();
    mkdirSync(join(data, "summer-trip"));
    writeFileSync(join(data, "summer-trip", "index.html"), "mine");
    const res = await app.request("http://localhost/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Summer trip", width: 1280, height: 720 }),
    });
    expect(res.status).toBe(409);
    expect(readFileSync(join(data, "summer-trip", "index.html"), "utf8")).toBe("mine");
  });
});

describe("createProjectFolder", () => {
  it("never reuses an existing folder, even an empty one", () => {
    const { data } = fixture();
    mkdirSync(join(data, "empty"));
    expect(() => createProjectFolder(data, "empty", FILES)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readdirSync(join(data, "empty"))).toEqual([]);
  });

  it("does not follow a link that holds the name", () => {
    const { root, data } = fixture();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(data, "linked"), "dir");
    expect(() => createProjectFolder(data, "linked", FILES)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.each(["", ".", "..", "../outside", "a/b", "a\\b"])("refuses the id %j", (id) => {
    const { root, data } = fixture();
    expect(() => createProjectFolder(data, id, FILES)).toThrow();
    expect(readdirSync(root)).not.toContain("outside");
  });

  it("removes the folder it made when a file would escape it, and writes nothing outside", () => {
    const { root, data } = fixture();
    expect(() =>
      createProjectFolder(data, "demo", { "index.html": "ok", "../../escaped.txt": "no" }),
    ).toThrow(/escapes its folder/);
    expect(existsSync(join(data, "demo"))).toBe(false);
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
  });

  it("writes nested files", () => {
    const { data } = fixture();
    const project = createProjectFolder(data, "demo", { "compositions/scene.html": "s" });
    expect(readFileSync(join(project.dir, "compositions", "scene.html"), "utf8")).toBe("s");
  });
});
