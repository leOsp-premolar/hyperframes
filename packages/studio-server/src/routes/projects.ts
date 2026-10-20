import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { StudioApiAdapter } from "../types.js";
import { buildNewProjectFiles, parseNewProjectRequest } from "../helpers/newProject.js";
import { isInHiddenOrVendorDir, isPrivateProjectPath, walkDir } from "../helpers/safePath.js";
import { isCompositionSource } from "../helpers/hfIdPersist.js";
import { resolveProjectSignature } from "../helpers/projectSignature.js";

async function filterCompositionFiles(projectDir: string, files: string[]): Promise<string[]> {
  const htmlFiles = files.filter((f) => f.endsWith(".html") && !isInHiddenOrVendorDir(f));
  const checks = await Promise.all(
    htmlFiles.map(async (f) => {
      try {
        const content = await readFile(join(projectDir, f), "utf-8");
        return isCompositionSource(content);
      } catch {
        return false;
      }
    }),
  );
  return htmlFiles.filter((_, i) => checks[i]);
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}

function projectExists(c: Context, id: string) {
  return c.json({ error: `A project named "${id}" already exists`, id }, 409);
}

export function registerProjectRoutes(api: Hono, adapter: StudioApiAdapter): void {
  // List all projects, and whether this host can create more.
  api.get("/projects", async (c) => {
    const projects = await adapter.listProjects();
    return c.json({ projects, canCreateProjects: Boolean(adapter.createProject) });
  });

  // Create a project from a name and its starting settings. The id comes from the name.
  api.post("/projects", async (c) => {
    if (!adapter.createProject) {
      return c.json({ error: "This Studio serves a single project and cannot create others" }, 501);
    }
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = parseNewProjectRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { settings } = parsed;
    // Checked before writing so the answer names the clash; the adapter's exclusive create stays the owner.
    if (await adapter.resolveProject(settings.id)) return projectExists(c, settings.id);
    try {
      const project = await adapter.createProject(settings.id, buildNewProjectFiles(settings));
      return c.json({ project: { id: project.id, title: project.title ?? project.id } }, 201);
    } catch (err) {
      if (isAlreadyExists(err)) return projectExists(c, settings.id);
      throw err;
    }
  });

  // Resolve session to project (multi-project mode)
  api.get("/resolve-session/:sessionId", async (c) => {
    if (!adapter.resolveSession) {
      return c.json({ error: "not available" }, 404);
    }
    const { sessionId } = c.req.param();
    const result = await adapter.resolveSession(sessionId);
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result);
  });

  // Current content signature for a project: a cheap poll target for clients that refresh when files change on disk.
  api.get("/projects/:id/signature", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json({ signature: resolveProjectSignature(adapter, project.dir) });
  });

  // Project file tree
  api.get("/projects/:id", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const files = walkDir(project.dir).filter((file) => !isPrivateProjectPath(file));
    const compositions = await filterCompositionFiles(project.dir, files);
    return c.json({ id: project.id, dir: project.dir, title: project.title, files, compositions });
  });
}
