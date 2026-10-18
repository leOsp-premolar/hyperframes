import { useCallback, useEffect, useRef, useState } from "react";
import { MEDIA_ACCEPT } from "../utils/mediaTypes";
import {
  fetchMissingMedia,
  requestMediaReplacement,
  useMissingMediaStore,
} from "../utils/missingMedia";

interface UseMissingMediaOptions {
  projectId: string | null;
  /** Bumped after Studio's own file changes; each bump checks again. */
  refreshKey: number;
  showToast: (message: string, tone?: "error" | "info") => void;
  /** After a replacement lands: reload the preview and the file list. */
  onReplaced: () => void;
}

/** Ask the browser for one file; resolves null when the picker is cancelled. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.hidden = true;
    input.dataset.testid = "missing-media-file-input";
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

function replacedMessage(path: string, newPath: string, warnings: readonly string[]): string {
  const done = newPath === path ? `Replaced ${path}.` : `Replaced ${path} with ${newPath}.`;
  return warnings.length ? `${done} ${warnings.join(" ")}` : done;
}

/**
 * Keeps the missing-media store current for this project, and owns the one way to fix an entry:
 * pick a file, upload it, and refresh. Cancelling the picker or a refused file changes nothing.
 */
export function useMissingMedia({
  projectId,
  refreshKey,
  showToast,
  onReplaced,
}: UseMissingMediaOptions): void {
  const [checks, setChecks] = useState(0);
  const optionsRef = useRef({ showToast, onReplaced });
  optionsRef.current = { showToast, onReplaced };
  const busyRef = useRef(false);

  const replace = useCallback(
    async (path: string) => {
      if (!projectId || busyRef.current) return;
      const entry = useMissingMediaStore.getState().missing.find((item) => item.path === path);
      const file = await pickFile(entry ? MEDIA_ACCEPT[entry.kind] : "");
      if (!file) return;
      busyRef.current = true;
      const outcome = await requestMediaReplacement(projectId, path, file);
      busyRef.current = false;
      const { showToast: toast, onReplaced: replaced } = optionsRef.current;
      if (!outcome.ok) {
        toast(outcome.error);
        return;
      }
      toast(replacedMessage(path, outcome.path, outcome.warnings), "info");
      replaced();
      setChecks((n) => n + 1);
    },
    [projectId],
  );

  useEffect(() => {
    const recheck = () => setChecks((n) => n + 1);
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  useEffect(() => {
    const { set } = useMissingMediaStore.getState();
    if (!projectId) {
      set([], null);
      return;
    }
    let current = true;
    const open = (path: string) => void replace(path);
    void fetchMissingMedia(projectId).then((missing) => {
      // A failed check keeps what is shown; the next one corrects it.
      if (current && missing) set(missing, open);
    });
    return () => {
      current = false;
    };
  }, [projectId, refreshKey, checks, replace]);

  useEffect(() => () => useMissingMediaStore.getState().set([], null), []);
}
