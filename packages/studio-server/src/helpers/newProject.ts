/**
 * What a "New project" request may ask for, and the files it starts with.
 *
 * The project id is derived from the name, never taken from the client, so the
 * id is always a single safe path segment: lowercase letters, digits and dashes.
 * The starting composition needs no network (no CDN script) and declares
 * `data-no-timeline`, so a project without animations renders without the
 * producer waiting for a timeline that will never register.
 */

const NEW_PROJECT_NAME_MAX = 80;
const NEW_PROJECT_ID_MAX = 64;
const NEW_PROJECT_MIN_SIDE = 128;
const NEW_PROJECT_MAX_SIDE = 7680;
const NEW_PROJECT_MAX_DURATION_S = 3600;

export interface NewProjectSettings {
  name: string;
  id: string;
  width: number;
  height: number;
  durationSeconds: number;
  background: string;
}

export type NewProjectParse =
  | { ok: true; settings: NewProjectSettings }
  | { ok: false; error: string };

// Names Windows refuses as folder names, whatever their extension.
const RESERVED_IDS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** The folder name for a project name, or null when nothing usable is left. */
export function projectIdFromName(name: string): string | null {
  const id = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NEW_PROJECT_ID_MAX)
    .replace(/-+$/, "");
  if (!id || RESERVED_IDS.has(id)) return null;
  return id;
}

function readSide(value: unknown, label: string): number | string {
  if (typeof value !== "number" || !Number.isInteger(value))
    return `${label} must be a whole number`;
  if (value < NEW_PROJECT_MIN_SIDE || value > NEW_PROJECT_MAX_SIDE) {
    return `${label} must be between ${NEW_PROJECT_MIN_SIDE} and ${NEW_PROJECT_MAX_SIDE} pixels`;
  }
  // H.264 and most players need even frame sides.
  if (value % 2 !== 0) return `${label} must be an even number of pixels`;
  return value;
}

function readDuration(value: unknown): number | string {
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isFinite(value)) return "duration must be a number";
  if (value < 1 || value > NEW_PROJECT_MAX_DURATION_S) {
    return `duration must be between 1 and ${NEW_PROJECT_MAX_DURATION_S} seconds`;
  }
  return Math.round(value * 100) / 100;
}

function readBackground(value: unknown): string | null {
  if (value === undefined) return "#000000";
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check a request body; the error strings are shown to the user as they are. */
export function parseNewProjectRequest(input: unknown): NewProjectParse {
  if (!isRecord(input)) return { ok: false, error: "expected a JSON object" };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the project a name" };
  if (name.length > NEW_PROJECT_NAME_MAX) {
    return { ok: false, error: `The name can be at most ${NEW_PROJECT_NAME_MAX} characters` };
  }
  const id = projectIdFromName(name);
  if (!id) return { ok: false, error: "Use at least one letter or number in the project name" };
  const width = readSide(input.width, "width");
  if (typeof width === "string") return { ok: false, error: width };
  const height = readSide(input.height, "height");
  if (typeof height === "string") return { ok: false, error: height };
  const durationSeconds = readDuration(input.durationSeconds);
  if (typeof durationSeconds === "string") return { ok: false, error: durationSeconds };
  const background = readBackground(input.background);
  if (!background) return { ok: false, error: "background must be a colour like #000000" };
  return { ok: true, settings: { name, id, width, height, durationSeconds, background } };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The files of a new project, keyed by path inside the project folder. */
export function buildNewProjectFiles(settings: NewProjectSettings): Record<string, string> {
  const { width, height, durationSeconds, background } = settings;
  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${escapeHtml(settings.name)}</title>
    <style>
      html,
      body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: ${background};
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${durationSeconds}"
      data-width="${width}"
      data-height="${height}"
      data-no-timeline
    ></div>
  </body>
</html>
`;
  const config = {
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    paths: {
      blocks: "compositions",
      components: "compositions/components",
      assets: "assets",
    },
  };
  return {
    "index.html": indexHtml,
    "hyperframes.json": `${JSON.stringify(config, null, 2)}\n`,
  };
}
