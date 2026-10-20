// @vitest-environment happy-dom

/**
 * The New project form sends what the user chose and shows the server's answer:
 * open the new project, or the existing one a taken name points at, or the reason it failed.
 */
import React, { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buttonWithText,
  cleanupMounted,
  mountHost,
  typeInto as type,
} from "./ui/mountHost.testHelpers";
import { NewProjectForm } from "./NewProjectForm";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupMounted();
});

function mount(props: Partial<React.ComponentProps<typeof NewProjectForm>> = {}) {
  const onOpenProject = vi.fn();
  const host = mountHost(<NewProjectForm onOpenProject={onOpenProject} {...props} />);
  return { host, onOpenProject };
}

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

function submitButton(host: HTMLElement) {
  return buttonWithText(host, "Create project");
}

async function submit(host: HTMLElement) {
  await act(async () => {
    submitButton(host).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function sentBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body));
}

it("cannot be submitted without a name", async () => {
  const { host } = mount();
  expect(submitButton(host).disabled).toBe(true);
  type(host, "#new-project-name", "   ");
  expect(submitButton(host).disabled).toBe(true);
  await submit(host);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("sends the chosen preset, length and background, then opens the new project", async () => {
  const { host, onOpenProject } = mount();
  answer(201, { project: { id: "summer-trip", title: "summer-trip" } });
  type(host, "#new-project-name", "Summer Trip");
  type(host, "#new-project-resolution", "1080x1920");
  type(host, "#new-project-duration", "15");
  type(host, "#new-project-background", "#112233");
  await submit(host);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects");
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(sentBody()).toEqual({
    name: "Summer Trip",
    width: 1080,
    height: 1920,
    durationSeconds: 15,
    background: "#112233",
  });
  expect(onOpenProject).toHaveBeenCalledWith("summer-trip");
});

it("leaves the defaults to the server: 1080p, 10 s, and no background unless one is chosen", async () => {
  const { host } = mount();
  answer(201, { project: { id: "plain" } });
  type(host, "#new-project-name", "Plain");
  expect(host.textContent).toContain("Black (default)");
  await submit(host);
  expect(sentBody()).toEqual({ name: "Plain", width: 1920, height: 1080, durationSeconds: 10 });
});

it("sends a custom frame size", async () => {
  const { host } = mount();
  answer(201, { project: { id: "wide" } });
  type(host, "#new-project-name", "Wide");
  expect(host.querySelector("#new-project-width")).toBeNull();
  type(host, "#new-project-resolution", "custom");
  type(host, "#new-project-width", "2560");
  type(host, "#new-project-height", "1080");
  await submit(host);
  expect(sentBody()).toMatchObject({ width: 2560, height: 1080 });
});

it("shows the server's reason and stays open when the settings are refused", async () => {
  const { host, onOpenProject } = mount();
  answer(400, { error: "width must be an even number of pixels" });
  type(host, "#new-project-name", "Odd");
  await submit(host);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "width must be an even number of pixels",
  );
  expect(onOpenProject).not.toHaveBeenCalled();
  expect(submitButton(host).disabled).toBe(false);
});

it("offers to open the project a taken name points at", async () => {
  const { host, onOpenProject } = mount();
  answer(409, { error: 'A project named "launch" already exists', id: "launch" });
  type(host, "#new-project-name", "Launch");
  await submit(host);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("already exists");
  const open = [...(alert?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === "Open it",
  );
  act(() => open?.click());
  expect(onOpenProject).toHaveBeenCalledWith("launch");
});

it("explains a server that cannot be reached", async () => {
  const { host } = mount();
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  type(host, "#new-project-name", "Offline");
  await submit(host);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not reach its server");
});

it("offers Cancel only when the host can close it", () => {
  const withCancel = mount({ onCancel: vi.fn() }).host;
  expect([...withCancel.querySelectorAll("button")].some((b) => b.textContent === "Cancel")).toBe(
    true,
  );
});
