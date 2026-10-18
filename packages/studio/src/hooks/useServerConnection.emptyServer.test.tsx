// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { useServerConnection } from "./useServerConnection";

vi.mock("../utils/studioTelemetry", () => ({ trackStudioEvent: vi.fn() }));

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

const seen: Array<{ serverHasNoProjects: boolean; canCreateProjects: boolean }> = [];

function Probe() {
  const { serverHasNoProjects, canCreateProjects } = useServerConnection();
  seen.push({ serverHasNoProjects, canCreateProjects });
  return null;
}

/** An empty project list is a wait for a project, not for the server; say which, and whether it can be created. */
it.each([
  [
    { projects: [], canCreateProjects: true },
    { serverHasNoProjects: true, canCreateProjects: true },
  ],
  [{ projects: [] }, { serverHasNoProjects: true, canCreateProjects: false }],
  [
    { projects: [{ id: "demo" }], canCreateProjects: true },
    { serverHasNoProjects: false, canCreateProjects: true },
  ],
])("reads %j as %j", async (list, expected) => {
  seen.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(list), { status: 200 })),
  );
  mountHost(<Probe />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(seen.at(-1)).toEqual(expected);
});
