import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintProject } from "@hyperframes/core/lint";
import { buildNewProjectFiles, parseNewProjectRequest, projectIdFromName } from "./newProject";

const VALID = { name: "Launch Video", width: 1920, height: 1080, durationSeconds: 10 };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settingsFor(body: unknown) {
  const parsed = parseNewProjectRequest(body);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.settings;
}

describe("projectIdFromName", () => {
  it.each([
    ["Launch Video", "launch-video"],
    ["  Mi vídeo de prueba  ", "mi-video-de-prueba"],
    ["Q3 / Recap: 2026!", "q3-recap-2026"],
    ["---Hello---", "hello"],
    ["Ünïcödé Ñame", "unicode-name"],
  ])("turns %j into %j", (name, id) => {
    expect(projectIdFromName(name)).toBe(id);
  });

  it.each(["../../etc", "..\\..\\windows", "/absolute/path", "a/b", "C:\\temp"])(
    "keeps path syntax out of the id for %j",
    (name) => {
      const id = projectIdFromName(name);
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    },
  );

  it.each(["", "   ", "!!!", "…", "日本語", "..", "CON", "nul", "Lpt1"])(
    "has no id for %j",
    (name) => {
      expect(projectIdFromName(name)).toBeNull();
    },
  );

  it("caps the id at 64 characters without a trailing dash", () => {
    const id = projectIdFromName(`${"a".repeat(63)} b c`);
    expect(id).toBe("a".repeat(63));
  });
});

describe("parseNewProjectRequest", () => {
  it("accepts a complete request and fills the defaults", () => {
    expect(parseNewProjectRequest({ name: " Launch Video ", width: 1080, height: 1920 })).toEqual({
      ok: true,
      settings: {
        name: "Launch Video",
        id: "launch-video",
        width: 1080,
        height: 1920,
        durationSeconds: 10,
        background: "#000000",
      },
    });
  });

  it.each([
    [null, "expected a JSON object"],
    [[], "expected a JSON object"],
    [{ ...VALID, name: "" }, "Give the project a name"],
    [{ ...VALID, name: 42 }, "Give the project a name"],
    [{ ...VALID, name: "x".repeat(81) }, "at most 80 characters"],
    [{ ...VALID, name: "///" }, "at least one letter or number"],
    [{ ...VALID, width: "1920" }, "width must be a whole number"],
    [{ ...VALID, width: 1919.5 }, "width must be a whole number"],
    [{ ...VALID, width: 1921 }, "width must be an even number"],
    [{ ...VALID, height: 64 }, "height must be between 128 and 7680"],
    [{ ...VALID, height: 8000 }, "height must be between 128 and 7680"],
    [{ ...VALID, durationSeconds: 0 }, "duration must be between 1 and 3600"],
    [{ ...VALID, durationSeconds: Number.NaN }, "duration must be a number"],
    [{ ...VALID, background: "red" }, "background must be a colour"],
    [{ ...VALID, background: "#12345g" }, "background must be a colour"],
  ])("rejects %j", (body, message) => {
    const parsed = parseNewProjectRequest(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("rounds the duration to the centisecond, as the timeline saves it", () => {
    expect(settingsFor({ ...VALID, durationSeconds: 12.3456 }).durationSeconds).toBe(12.35);
  });
});

describe("buildNewProjectFiles", () => {
  it("writes a composition sized and timed from the settings, with no network", () => {
    const files = buildNewProjectFiles(
      settingsFor({
        ...VALID,
        width: 1080,
        height: 1350,
        durationSeconds: 7.5,
        background: "#1A2B3C",
      }),
    );
    expect(Object.keys(files).sort()).toEqual(["hyperframes.json", "index.html"]);
    const html = files["index.html"];
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-duration="7.5"');
    expect(html).toContain('data-width="1080"');
    expect(html).toContain('data-height="1350"');
    expect(html).toContain("data-no-timeline");
    expect(html).toContain("background: #1a2b3c;");
    expect(html).not.toMatch(/<script|https?:\/\/(?!www\.w3)/);
    expect(JSON.parse(files["hyperframes.json"]).paths.assets).toBe("assets");
  });

  it("escapes the name it puts in the page title", () => {
    const html = buildNewProjectFiles(settingsFor({ ...VALID, name: 'A <b>"bold"</b> & co' }))[
      "index.html"
    ];
    expect(html).toContain("<title>A &lt;b&gt;&quot;bold&quot;&lt;/b&gt; &amp; co</title>");
  });

  it("starts lint-clean, so the first render does not wait for a timeline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-new-project-"));
    tempDirs.push(dir);
    for (const [file, content] of Object.entries(buildNewProjectFiles(settingsFor(VALID)))) {
      writeFileSync(join(dir, file), content);
    }
    const result = await lintProject(dir, undefined, { host: "studio" });
    const findings = result.results.flatMap((r) => r.result.findings);
    expect(findings).toEqual([]);
    expect(result.totalErrors + result.totalWarnings + result.totalInfos).toBe(0);
  });
});
