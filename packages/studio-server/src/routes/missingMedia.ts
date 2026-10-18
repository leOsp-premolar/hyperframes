import { readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import type { Hono } from "hono";
import { createFileAtomically, replaceFileAtomically } from "@hyperframes/core/atomic-file";
import type { StudioApiAdapter } from "../types.js";
import { mkdirWithinProject, pinWithinProject } from "../helpers/safePath.js";
import { snapshotBeforeWrite } from "../helpers/backupJournal.js";
import {
  createWriteToken,
  fileContentVersion,
  recordFileWriteReceipt,
} from "../helpers/fileVersion.js";
import { probeMediaDetails } from "../helpers/mediaMetadata.js";
import {
  STUDIO_IMPORT_EXTENSIONS,
  unsupportedImportReason,
  validateUploadedMediaBuffer,
} from "../helpers/mediaValidation.js";
import {
  findMissingMedia,
  mediaKindOfPath,
  silenceDeclaredAudio,
  type MissingMedia,
  type MissingMediaReference,
} from "../helpers/missingMedia.js";
import { MAX_UPLOAD_BYTES, planReferenceUpdates, type ReferenceUpdate } from "./files.js";

type Failure = { error: string; status: 400 | 404 | 409 | 413 | 422 | 500 };

export interface ReplaceMediaTools {
  validate: typeof validateUploadedMediaBuffer;
  probe: typeof probeMediaDetails;
  /** Writes one rewritten composition; a test swaps it to fail part way. */
  writeText: (file: string, text: string, mode: number) => void;
}

const defaultTools: ReplaceMediaTools = {
  validate: validateUploadedMediaBuffer,
  probe: probeMediaDetails,
  writeText: replaceFileAtomically,
};

const formats = (kind: MissingMedia["kind"]) =>
  STUDIO_IMPORT_EXTENSIONS[kind].map((ext) => ext.toUpperCase()).join(", ");

/** Why `fileName` cannot stand in for `missing`, or null when its type fits. */
function typeMismatch(missing: MissingMedia, fileName: string): string | null {
  const unsupported = unsupportedImportReason(fileName);
  if (unsupported) return `${fileName}: ${unsupported}`;
  const kind = mediaKindOfPath(fileName);
  if (kind === missing.kind) return null;
  const what = kind ? `is ${kind === "image" ? "an image" : `${kind}`}` : "is not media";
  return `${fileName} ${what}, but ${missing.path} is used as ${missing.kind === "image" ? "an image" : missing.kind}. Choose a ${formats(missing.kind)} file.`;
}

/**
 * Where the new file goes: the missing file's own name when that name is free and the
 * extension matches, so no reference changes; else the same folder and stem with the new
 * extension, numbered when taken. Never a path that already exists.
 */
function destinationFor(projectDir: string, missing: MissingMedia, fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const sameExt = extname(missing.path).toLowerCase() === ext;
  if (sameExt && missing.reason === "missing") return missing.path;
  const dir = posix.dirname(missing.path);
  const stem = posix.basename(missing.path, posix.extname(missing.path));
  const taken = (path: string) =>
    Boolean(statSync(join(projectDir, path), { throwIfNoEntry: false }));
  for (let index = 1; ; index++) {
    const name = `${stem}${index === 1 && !sameExt ? "" : `-${index}`}${ext}`;
    const candidate = dir === "." ? name : `${dir}/${name}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The folders between the project and `dir` that do not exist yet, deepest first. */
function absentFolders(projectDir: string, dir: string): string[] {
  const absent: string[] = [];
  for (let at = dir; at !== projectDir && at !== dirname(at); at = dirname(at)) {
    if (statSync(at, { throwIfNoEntry: false })) break;
    absent.push(at);
  }
  return absent;
}

function removeEmptyFolders(folders: readonly string[]): void {
  for (const folder of folders) {
    try {
      if (readdirSync(folder).length === 0) rmdirSync(folder);
    } catch {
      // Left in place: something else wrote there, or it is already gone.
    }
  }
}

/** Write every rewrite or none: a failure puts back the files already written and rethrows. */
function applyAll(updates: readonly ReferenceUpdate[], tools: ReplaceMediaTools): void {
  const written: ReferenceUpdate[] = [];
  try {
    for (const update of updates) {
      tools.writeText(update.file, update.updated, update.mode);
      written.push(update);
    }
  } catch (error) {
    for (const update of written.reverse()) {
      replaceFileAtomically(update.file, update.content, update.mode);
    }
    throw error;
  }
}

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

const seconds = (value: number) => `${Number(value.toFixed(2))}s`;
const clipName = (ref: MissingMediaReference) => (ref.id ? `"${ref.id}"` : `a clip in ${ref.file}`);

type MediaFacts = Awaited<ReturnType<ReplaceMediaTools["probe"]>>;

/** The new file's facts, or null for an image or a file the probe cannot read. */
async function probeFacts(
  absPath: string,
  missing: MissingMedia,
  probe: ReplaceMediaTools["probe"],
): Promise<MediaFacts | null> {
  if (missing.kind === "image") return null;
  const facts = await probe(absPath).catch(() => null);
  return facts && !facts.probeError ? facts : null;
}

/** A silent video for clips that say they have sound: export would fail looking for it. */
const losesSound = (missing: MissingMedia, facts: MediaFacts | null) =>
  missing.kind === "video" && facts?.hasAudio === false;

/** What the new file changes about the clips that use it; their own settings are kept as they were. */
function compatibilityWarnings(missing: MissingMedia, facts: MediaFacts | null): string[] {
  if (!facts) return [];
  const warnings = new Set<string>();
  for (const ref of missing.references) {
    const needs = ref.mediaStart + ref.duration * ref.playbackRate;
    if (facts.durationSeconds && ref.duration > 0 && needs > facts.durationSeconds + 0.05) {
      warnings.add(
        `${clipName(ref)} plays the source up to ${seconds(needs)}, but the new file is ${seconds(facts.durationSeconds)} long; the end of the clip will have no new picture or sound.`,
      );
    }
    if (ref.declaresAudio && losesSound(missing, facts)) {
      warnings.add(
        `${clipName(ref)} is now marked silent: the new file has no audio track for its sound.`,
      );
    }
  }
  return [...warnings];
}

interface ReplaceRequest {
  projectDir: string;
  missingPath: string;
  fileName: string;
  bytes: Uint8Array;
  writeToken: string;
}

interface Replaced {
  path: string;
  updatedReferences: string[];
  warnings: string[];
  unchecked?: string;
}

const reversed = (update: ReferenceUpdate): ReferenceUpdate => ({
  ...update,
  content: update.updated,
  updated: update.content,
});

/**
 * Every composition change the replacement makes, not yet written: the new file name where it
 * differs, and `data-has-audio="false"` on clips that declared sound the new file does not have.
 */
function planUpdates(
  projectDir: string,
  missing: MissingMedia,
  path: string,
  silence: boolean,
): ReferenceUpdate[] {
  const renamed =
    path === missing.path ? [] : planReferenceUpdates(projectDir, missing.path, path, false);
  const updates = new Map(renamed.map((update) => [update.file, update]));
  if (!silence) return renamed;
  const files = new Set(missing.references.filter((ref) => ref.declaresAudio).map((r) => r.file));
  for (const file of files) {
    const abs = join(projectDir, file);
    const text = readFileSync(abs, "utf8");
    const base = updates.get(abs) ?? {
      file: abs,
      content: text,
      updated: text,
      mode: statSync(abs).mode,
    };
    const updated = silenceDeclaredAudio(projectDir, file, base.updated, path);
    if (updated !== base.content) updates.set(abs, { ...base, updated });
  }
  return [...updates.values()];
}

/** Back up each composition, write the rewrites as one, and leave receipts so Studio knows them as its own. */
function rewriteReferences(
  request: ReplaceRequest,
  updates: readonly ReferenceUpdate[],
  tools: ReplaceMediaTools,
): string[] {
  for (const update of updates) {
    const backup = snapshotBeforeWrite(request.projectDir, update.file);
    if (backup.error) throw new Error(`could not back up ${update.file}: ${backup.error}`);
  }
  applyAll(updates, tools);
  return updates.map((update) => {
    const path = posix.normalize(
      update.file.slice(request.projectDir.length + 1).replace(/\\/g, "/"),
    );
    recordFileWriteReceipt(update.file, {
      path,
      version: fileContentVersion(update.updated),
      writeToken: request.writeToken,
      overwrote: update.content,
    });
    return path;
  });
}

/** The missing entry `bytes` may stand in for, or why it cannot. */
function checkReplacement(
  request: ReplaceRequest,
  validate: ReplaceMediaTools["validate"],
): { missing: MissingMedia; unchecked?: string } | Failure {
  const { projectDir, missingPath, fileName } = request;
  const missing = findMissingMedia(projectDir).find((entry) => entry.path === missingPath);
  if (!missing) {
    return { error: `${missingPath} is not missing; no clip needs it replaced`, status: 409 };
  }
  const mismatch = typeMismatch(missing, fileName);
  if (mismatch) return { error: mismatch, status: 400 };
  const check = validate(fileName, request.bytes);
  if (!check.ok) return { error: `${fileName} ${check.reason}`, status: 422 };
  return { missing, unchecked: check.unchecked };
}

/** Create the new file at `path`, never over another; `undo` removes it and the folders it made. */
function writeNewFile(
  projectDir: string,
  path: string,
  bytes: Uint8Array,
): { absPath: string; undo: () => void } | Failure {
  const absPath = pinWithinProject(projectDir, path);
  if (!absPath) return { error: `forbidden path: ${path}`, status: 400 };
  const created = absentFolders(projectDir, dirname(absPath));
  try {
    mkdirWithinProject(projectDir, dirname(absPath));
    createFileAtomically(absPath, bytes);
  } catch (error) {
    removeEmptyFolders(created);
    if (errorCode(error) !== "EEXIST") throw error;
    return { error: `${path} appeared while replacing; nothing was changed`, status: 409 };
  }
  const undo = () => {
    rmSync(absPath, { force: true });
    removeEmptyFolders(created);
  };
  return { absPath, undo };
}

/** Rewrite the compositions for the new file, or put them back and say why. */
function relink(
  request: ReplaceRequest,
  missing: MissingMedia,
  path: string,
  silence: boolean,
  tools: ReplaceMediaTools,
): string[] | Failure {
  let updates: ReferenceUpdate[];
  let written: string[];
  try {
    updates = planUpdates(request.projectDir, missing, path, silence);
    written = rewriteReferences(request, updates, tools);
  } catch (error) {
    return {
      error: `Could not update the clips: ${String(error)}; nothing was changed`,
      status: 500,
    };
  }
  if (!findMissingMedia(request.projectDir).some((entry) => entry.path === missing.path)) {
    return written;
  }
  // A spelling of the old path the rewrite does not know: a half-relinked project is worse than none.
  rewriteReferences(request, updates.map(reversed), tools);
  return {
    error: `Some references to ${missing.path} could not be updated; nothing was changed. Give the new file the missing file's type and name instead.`,
    status: 409,
  };
}

/**
 * Put `bytes` where a missing file was, so every clip that named it plays the new file with its
 * timing, trims, transforms and audio settings untouched. All or nothing: a refusal or failure
 * leaves every project file as it was and removes what this call created.
 */
async function replaceMissingMedia(
  request: ReplaceRequest,
  tools: ReplaceMediaTools,
): Promise<Replaced | Failure> {
  const accepted = checkReplacement(request, tools.validate);
  if ("error" in accepted) return accepted;
  const { missing, unchecked } = accepted;
  const path = destinationFor(request.projectDir, missing, request.fileName);
  const file = writeNewFile(request.projectDir, path, request.bytes);
  if ("error" in file) return file;
  const facts = await probeFacts(file.absPath, missing, tools.probe);
  const updatedReferences = relink(request, missing, path, losesSound(missing, facts), tools);
  if ("error" in updatedReferences) {
    file.undo();
    return updatedReferences;
  }
  return {
    path,
    updatedReferences,
    warnings: compatibilityWarnings(missing, facts),
    ...(unchecked ? { unchecked } : {}),
  };
}

type UploadedFile = {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function isUploadedFile(value: unknown): value is UploadedFile {
  return typeof value === "object" && value !== null && "arrayBuffer" in value && "name" in value;
}

export function registerMissingMediaRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  tools: ReplaceMediaTools = defaultTools,
): void {
  api.get("/projects/:id/media/missing", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json({ missing: findMissingMedia(project.dir) });
  });

  api.post("/projects/:id/media/replace", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const missingPath = c.req.query("path");
    if (!missingPath) return c.json({ error: "path required" }, 400);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!isUploadedFile(file)) return c.json({ error: "Choose a file to replace it with" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: `${file.name} is larger than the 500 MB import limit` }, 413);
    }
    const result = await replaceMissingMedia(
      {
        projectDir: project.dir,
        missingPath,
        fileName: file.name.split(/[\\/]/).pop() ?? file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        writeToken: createWriteToken(c.req.header("X-Hyperframes-Write-Token")),
      },
      tools,
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, ...result }, 201);
  });
}
