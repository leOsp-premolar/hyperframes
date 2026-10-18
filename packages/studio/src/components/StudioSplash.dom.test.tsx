// @vitest-environment happy-dom

/**
 * The splash tells a server that has not answered from one that answered with no project, and
 * offers the first project in the second case when the server can create one.
 */
import { afterEach, expect, it } from "vitest";
import { cleanupMounted, mountHost } from "./ui/mountHost.testHelpers";
import { StudioSplash } from "./StudioSplash";

afterEach(cleanupMounted);

it("still says it waits for the server when the server has not answered", () => {
  const host = mountHost(<StudioSplash waiting />);
  expect(host.textContent).toContain("Waiting for preview server");
  expect(host.querySelector("form")).toBeNull();
});

it("offers the first project when the server answered with none", () => {
  const host = mountHost(
    <StudioSplash waiting server={{ serverHasNoProjects: true, canCreateProjects: true }} />,
  );
  expect(host.textContent).toContain("Create your first project");
  expect(host.querySelector('form[aria-label="New project"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Waiting for preview server");
});

it("points at the CLI when the host cannot create projects", () => {
  const host = mountHost(
    <StudioSplash waiting server={{ serverHasNoProjects: true, canCreateProjects: false }} />,
  );
  expect(host.textContent).toContain("npx hyperframes init");
  expect(host.querySelector("form")).toBeNull();
});
