import { afterEach, describe, expect, it } from "vitest";
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
import { registerProjectRoutes } from "./projects";
import { stubAdapter } from "./stubAdapter.test-helpers";
import type { ResolvedProject, StudioApiAdapter } from "../types";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A projects folder inside a parent, so a write that escapes it shows up as a sibling. */
function projectsRoot() {
  const parent = mkdtempSync(join(tmpdir(), "hf-create-project-"));
  tempDirs.push(parent);
  const root = join(parent, "projects");
  mkdirSync(root);
  return { parent, root };
}

/** The contract the Vite adapter implements: an exclusive folder inside `root`. */
function creatingAdapter(
  root: string,
  overrides: Partial<StudioApiAdapter> = {},
): StudioApiAdapter {
  return {
    ...stubAdapter(root),
    listProjects: () =>
      readdirSync(root).map((id) => ({ id, dir: join(root, id) }) satisfies ResolvedProject),
    resolveProject: (id) => (existsSync(join(root, id)) ? { id, dir: join(root, id) } : null),
    createProject: (id, files) => {
      const dir = join(root, id);
      mkdirSync(dir);
      for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(dir, file), content, { flag: "wx" });
      }
      return { id, dir };
    },
    ...overrides,
  };
}

function app(adapter: StudioApiAdapter) {
  const api = new Hono();
  registerProjectRoutes(api, adapter);
  return api;
}

function post(api: Hono, body: unknown) {
  return api.request("http://localhost/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { name: "Launch Video", width: 1920, height: 1080 };

describe("GET /projects", () => {
  it("says whether this host can create projects", async () => {
    const { root } = projectsRoot();
    const single = await app(stubAdapter(root)).request("http://localhost/projects");
    expect(await single.json()).toMatchObject({ canCreateProjects: false });
    const multi = await app(creatingAdapter(root)).request("http://localhost/projects");
    expect(await multi.json()).toMatchObject({ canCreateProjects: true });
  });
});

describe("POST /projects", () => {
  it("answers 501 on a host that serves a single project", async () => {
    const { root } = projectsRoot();
    const res = await post(app(stubAdapter(root)), VALID);
    expect(res.status).toBe(501);
    expect(readdirSync(root)).toEqual([]);
  });

  it("creates the project, named from the title, and lists it", async () => {
    const { root } = projectsRoot();
    const api = app(creatingAdapter(root));
    const res = await post(api, { ...VALID, name: "Mi Vídeo", durationSeconds: 8 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ project: { id: "mi-video", title: "mi-video" } });
    const html = readFileSync(join(root, "mi-video", "index.html"), "utf8");
    expect(html).toContain('data-duration="8"');
    expect(html).toContain("data-no-timeline");
    expect(existsSync(join(root, "mi-video", "hyperframes.json"))).toBe(true);
    const listed = await (await api.request("http://localhost/projects")).json();
    expect(listed.projects.map((p: ResolvedProject) => p.id)).toEqual(["mi-video"]);
  });

  it.each([
    ["not JSON", "{name:"],
    ["no name", { width: 1920, height: 1080 }],
    ["an odd width", { ...VALID, width: 1921 }],
    ["a name with nothing usable", { ...VALID, name: "../.." }],
  ])("rejects %s with 400 and writes nothing", async (_case, body) => {
    const { root } = projectsRoot();
    const res = await post(app(creatingAdapter(root)), body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["../escaped", "..\\escaped", "/tmp/escaped", "nested/escaped"])(
    "keeps %j inside the projects folder",
    async (name) => {
      const { parent, root } = projectsRoot();
      const res = await post(app(creatingAdapter(root)), { ...VALID, name });
      expect(res.status).toBe(201);
      expect(readdirSync(parent)).toEqual(["projects"]);
      expect(readdirSync(root)).toHaveLength(1);
    },
  );

  it("refuses a name that is taken and leaves the existing project untouched", async () => {
    const { root } = projectsRoot();
    mkdirSync(join(root, "launch-video"));
    writeFileSync(join(root, "launch-video", "index.html"), "<p>mine</p>");
    const res = await post(app(creatingAdapter(root)), { ...VALID, name: "LAUNCH  video!" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ id: "launch-video" });
    expect(readFileSync(join(root, "launch-video", "index.html"), "utf8")).toBe("<p>mine</p>");
  });

  it("answers 409 when the folder appears between the check and the create", async () => {
    const { root } = projectsRoot();
    const raced = creatingAdapter(root, {
      resolveProject: () => null,
      createProject: () => {
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      },
    });
    expect((await post(app(raced), VALID)).status).toBe(409);
  });

  it("lets two requests for the same name produce one project", async () => {
    const { root } = projectsRoot();
    const api = app(creatingAdapter(root, { resolveProject: () => null }));
    const statuses = (await Promise.all([post(api, VALID), post(api, VALID)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(readdirSync(root)).toEqual(["launch-video"]);
  });

  it("does not hide other create failures as a clash", async () => {
    const { root } = projectsRoot();
    const broken = creatingAdapter(root, {
      createProject: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect((await post(app(broken), VALID)).status).toBe(500);
  });
});
