// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { crc32, writeStoredZip } from "./storedZip";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hf-zip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("computes the standard CRC-32", () => {
  expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
});

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

it.skipIf(!hasUnzip)("writes an archive unzip reads back byte for byte", () => {
  writeFileSync(join(dir, "a.png"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(dir, "b.txt"), "second file");
  const zip = join(dir, "out.zip");
  writeStoredZip(zip, [
    { name: "frame_000001.png", source: join(dir, "a.png") },
    { name: "notes/b.txt", source: join(dir, "b.txt") },
  ]);
  expect(spawnSync("unzip", ["-tq", zip]).status).toBe(0);
  const out = join(dir, "x");
  spawnSync("unzip", ["-q", zip, "-d", out]);
  expect(readFileSync(join(out, "frame_000001.png"))).toEqual(Buffer.from([0, 1, 2, 255]));
  expect(readFileSync(join(out, "notes/b.txt"), "utf8")).toBe("second file");
});

it("never writes over an existing file", () => {
  const zip = join(dir, "taken.zip");
  writeFileSync(zip, "keep");
  expect(() => writeStoredZip(zip, [])).toThrow();
  expect(readFileSync(zip, "utf8")).toBe("keep");
});
