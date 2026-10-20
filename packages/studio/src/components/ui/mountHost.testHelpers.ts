import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { root: Root; host: HTMLElement } | null = null;
const tracked: Root[] = [];

export function trackedRoot(host: HTMLElement): Root {
  const root = createRoot(host);
  tracked.push(root);
  return root;
}

/** Renders into a fresh host attached to the body; `cleanupMounted` tears it down. */
export function mountHost(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(element));
  return host;
}

export function cleanupMounted(): void {
  act(() => tracked.splice(0).forEach((root) => root.unmount()));
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
}

/** Sets a field's value the way typing does: React only hears the native event after the setter. */
export function typeInto(host: HTMLElement, selector: string, value: string): void {
  const el = host.querySelector(selector);
  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    )
  ) {
    throw new Error(`no field ${selector}`);
  }
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

/** The first button whose text includes `label`. */
export function buttonWithText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`no button "${label}"`);
  return button;
}
