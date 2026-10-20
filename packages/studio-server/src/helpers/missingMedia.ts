import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  decodeAuthoredAttribute,
  scanHtmlOpeningTags,
  type HtmlOpeningTagSpan,
} from "@hyperframes/parsers";
import { rewriteAssetPath } from "@hyperframes/parsers/asset-paths";
import {
  cleanAssetUrl,
  isRemoteOrInlineUrl,
  isUnresolvedAssetPlaceholder,
  resolveLocalAssetCandidates,
} from "@hyperframes/parsers/asset-resolution";
import { readLinkTiming } from "@hyperframes/core/media-link";
import { PREVIEW_IGNORED_DIRS } from "@hyperframes/core/project-folders";
import { STUDIO_IMPORT_EXTENSIONS } from "./mediaValidation.js";

export type MediaKind = "video" | "image" | "audio";

/** Why a referenced file cannot be used: gone, present but not readable, or a folder. */
export type MissingMediaReason = "missing" | "unreadable" | "not-a-file";

/** One element that names a missing file, with the clip facts a replacement should respect. */
export interface MissingMediaReference {
  /** The composition file, project-relative with forward slashes. */
  file: string;
  tag: string;
  /** The element's id, or its `data-hf-id`, when it has one. */
  id: string | null;
  start: number;
  duration: number;
  mediaStart: number;
  playbackRate: number;
  /** A video that says it has sound (`data-has-audio="true"`): export extracts it and needs it there. */
  declaresAudio: boolean;
}

export interface MissingMedia {
  /** Project-relative with forward slashes: where the references point. */
  path: string;
  kind: MediaKind;
  reason: MissingMediaReason;
  references: MissingMediaReference[];
}

const MEDIA_TAGS = new Set(["video", "img", "audio", "source"]);

const extensionOf = (path: string) => extname(path).slice(1).toLowerCase();

/** The kind of media a file is by its extension, or null for anything else. */
export function mediaKindOfPath(path: string): MediaKind | null {
  const ext = extensionOf(path);
  for (const kind of ["video", "image", "audio"] as const) {
    if (STUDIO_IMPORT_EXTENSIONS[kind].some((known) => known === ext)) return kind;
  }
  return null;
}

function kindOfTag(tag: string): MediaKind {
  if (tag === "img") return "image";
  if (tag === "audio") return "audio";
  return "video";
}

function projectHtmlFiles(root: string, dir = root): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || PREVIEW_IGNORED_DIRS.has(entry.name)) return [];
      return projectHtmlFiles(root, full);
    }
    return entry.isFile() && /\.html?$/i.test(entry.name) ? [full] : [];
  });
}

function attributeReader(tag: HtmlOpeningTagSpan) {
  return {
    getAttribute(name: string): string | null {
      const attribute = tag.attributes.find((attr) => attr.name === name);
      if (!attribute) return null;
      return attribute.kind === "value" ? decodeAuthoredAttribute(attribute.value) : "";
    },
  };
}

const declaresAudio = (clip: HtmlOpeningTagSpan) =>
  clip.name === "video" && attributeReader(clip).getAttribute("data-has-audio") === "true";

function reference(file: string, tag: HtmlOpeningTagSpan, clip: HtmlOpeningTagSpan) {
  const attrs = attributeReader(clip);
  const timing = readLinkTiming(attrs);
  return {
    file,
    tag: tag.name,
    id: attrs.getAttribute("id") || attrs.getAttribute("data-hf-id") || null,
    start: timing.start,
    duration: timing.duration,
    mediaStart: timing.mediaStart,
    playbackRate: timing.playbackRate,
    declaresAudio: declaresAudio(clip),
  };
}

/** Whether a resolved path is a readable file, or why not; null when nothing is there. */
function inspect(path: string): MissingMediaReason | "ok" | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isFile()) return "not-a-file";
  try {
    accessSync(path, constants.R_OK);
    return "ok";
  } catch {
    return "unreadable";
  }
}

const toPosix = (path: string) => path.split(sep).join("/");

/** The files a local `src` may name, nearest first, or null when it is not a local file. */
function localCandidates(projectDir: string, compSrcPath: string, rawSrc: string): string[] | null {
  // Placeholder check runs on the RAW value: cleanAssetUrl() splits on ?/# and would chop inside a ${...} token.
  if (isUnresolvedAssetPlaceholder(rawSrc)) return null;
  const src = cleanAssetUrl(rawSrc);
  if (!src || isRemoteOrInlineUrl(src)) return null;
  const rootRelative = rewriteAssetPath(compSrcPath, src, (path) =>
    Boolean(statSync(join(projectDir, path), { throwIfNoEntry: false })),
  );
  const candidates = resolveLocalAssetCandidates(projectDir, rootRelative);
  return candidates.length ? candidates : null;
}

/** Where a local `src` points and whether it is usable, or null when it is not a local file. */
function classify(
  projectDir: string,
  compSrcPath: string,
  rawSrc: string,
): { path: string; reason: MissingMediaReason } | null {
  const candidates = localCandidates(projectDir, compSrcPath, rawSrc);
  if (!candidates?.[0]) return null;
  let found: MissingMediaReason | null = null;
  for (const candidate of candidates) {
    const state = inspect(candidate);
    if (state === "ok") return null;
    found ??= state;
  }
  return { path: toPosix(relative(projectDir, candidates[0])), reason: found ?? "missing" };
}

/** The `<video>` or `<audio>` a `<source>` sits in; any other tag is its own clip. */
function enclosingClip(html: string, tag: HtmlOpeningTagSpan, open: HtmlOpeningTagSpan | null) {
  if (tag.name !== "source" || !open) return tag;
  const close = html.slice(open.end).search(new RegExp(`</${open.name}[\\s>]`, "i"));
  return close < 0 || tag.start < open.end + close ? open : tag;
}

/** Each media tag with a `src`, with the clip that carries its timing. */
function* mediaTags(html: string) {
  let openMedia: HtmlOpeningTagSpan | null = null;
  for (const tag of scanHtmlOpeningTags(html)) {
    if (!MEDIA_TAGS.has(tag.name)) continue;
    if (tag.name === "video" || tag.name === "audio") openMedia = tag;
    const src = attributeReader(tag).getAttribute("src");
    if (src) yield { tag, src, clip: enclosingClip(html, tag, openMedia) };
  }
}

/**
 * Every local file a composition's `<video>`, `<img>`, `<audio>` or `<source>` names that cannot be
 * played: missing, unreadable or a folder. Scans each HTML file in the project, resolving a nested
 * composition's relative paths from its own folder the way the preview does. Never throws on a
 * file it cannot read; that file is simply not scanned.
 */
export function findMissingMedia(projectDir: string): MissingMedia[] {
  const byPath = new Map<string, MissingMedia>();
  for (const htmlFile of projectHtmlFiles(projectDir)) {
    let html: string;
    try {
      html = readFileSync(htmlFile, "utf8");
    } catch {
      continue;
    }
    const file = toPosix(relative(projectDir, htmlFile));
    for (const { tag, src, clip } of mediaTags(html)) {
      const found = classify(projectDir, file, src);
      if (!found) continue;
      const entry = byPath.get(found.path) ?? {
        path: found.path,
        kind: mediaKindOfPath(found.path) ?? kindOfTag(clip.name),
        reason: found.reason,
        references: [],
      };
      entry.references.push(reference(file, tag, clip));
      byPath.set(found.path, entry);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `html` (the composition at project path `file`) with `data-has-audio="true"` turned to "false"
 * on each video that plays `path`: what Studio writes for a silent clip, and what export needs
 * once the file has no sound to extract. Everything else in the text is left as it was.
 */
export function silenceDeclaredAudio(
  projectDir: string,
  file: string,
  html: string,
  path: string,
): string {
  const target = resolve(projectDir, path);
  const edits: Array<{ start: number; end: number }> = [];
  for (const { src, clip } of mediaTags(html)) {
    if (!declaresAudio(clip) || !localCandidates(projectDir, file, src)?.includes(target)) continue;
    const attribute = clip.attributes.find((attr) => attr.name === "data-has-audio");
    if (attribute?.kind === "value") edits.push({ start: attribute.start, end: attribute.end });
  }
  let out = html;
  for (const { start, end } of [...new Map(edits.map((e) => [e.start, e])).values()].sort(
    (a, b) => b.start - a.start,
  )) {
    out = `${out.slice(0, start)}data-has-audio="false"${out.slice(end)}`;
  }
  return out;
}
