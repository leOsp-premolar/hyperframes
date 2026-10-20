import { useEffect, useState } from "react";
import { STUDIO_SOLO_SILENCED_ATTR } from "@hyperframes/core/studio-preview-mark";
import { usePlayerStore } from "../player";
import { useTrackControlsStore } from "../player/store/trackControlsStore";
import { soloSilencedElements } from "../player/components/trackLockSolo";
import { findTimelineElementInIframe } from "./timelineEditingHelpers";
import { reseekPreviewRuntime } from "./timelineTrackVisibility";

interface Ref<T> {
  readonly current: T;
}

/** Put the silence mark on exactly `silenced`; whether anything changed. */
function markSilenced(doc: Document, silenced: ReadonlySet<Element>): boolean {
  let changed = false;
  for (const marked of doc.querySelectorAll(`[${STUDIO_SOLO_SILENCED_ATTR}]`)) {
    if (silenced.has(marked)) continue;
    marked.removeAttribute(STUDIO_SOLO_SILENCED_ATTR);
    changed = true;
  }
  for (const live of silenced) {
    if (live.hasAttribute(STUDIO_SOLO_SILENCED_ATTR)) continue;
    live.setAttribute(STUDIO_SOLO_SILENCED_ATTR, "");
    changed = true;
  }
  return changed;
}

/**
 * Mirror the soloed tracks into the live preview: every clip with sound off them carries the
 * preview-only silence mark the runtime honours, and nothing else does. Re-applied when the
 * timeline or the preview document changes, since a reload starts from the file, which never
 * carries the mark. Solo ends with the project.
 */
export function useTrackSoloPreview(
  projectId: string | null,
  previewIframeRef: Ref<HTMLIFrameElement | null>,
  activeCompPath: string | null,
): void {
  const soloTracks = useTrackControlsStore((s) => s.soloTracks);
  const elements = usePlayerStore((s) => s.elements);
  const [documentLoads, setDocumentLoads] = useState(0);

  useEffect(() => useTrackControlsStore.getState().clearSolo(), [projectId]);

  useEffect(() => {
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    const reloaded = () => setDocumentLoads((n) => n + 1);
    iframe.addEventListener("load", reloaded);
    return () => iframe.removeEventListener("load", reloaded);
  }, [previewIframeRef]);

  useEffect(() => {
    const iframe = previewIframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;
    const silenced = new Set<Element>();
    for (const element of soloSilencedElements(elements, soloTracks)) {
      const live = findTimelineElementInIframe(iframe, element, activeCompPath);
      if (live) silenced.add(live);
    }
    if (markSilenced(doc, silenced)) reseekPreviewRuntime(iframe);
  }, [soloTracks, elements, activeCompPath, previewIframeRef, documentLoads]);
}
