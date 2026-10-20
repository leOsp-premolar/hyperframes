export const STUDIO_PREVIEW_MARK_META = "hyperframes-studio-preview";
export const STUDIO_PREVIEW_UPCOMING_ATTR = "data-hf-upcoming";
export const STUDIO_PREVIEW_LAZY_ATTR = "data-hf-preview-lazy";
export const STUDIO_PREVIEW_ERRORS = "__hfPreviewErrors";
export const PREVIEW_RASTER_ATTR = "data-hf-preview-raster";
export const RUNTIME_STAMPED_ATTR = "data-hf-autostamped";
/** Studio's track solo: a clip silenced in the preview only. The file and the render never carry it. */
export const STUDIO_SOLO_SILENCED_ATTR = "data-hf-solo-silenced";
/** Silenced by Studio's solo: on the clip itself or an ancestor, like `data-hidden`. */
export function isSoloSilenced(el: Element): boolean {
  return el.closest(`[${STUDIO_SOLO_SILENCED_ATTR}]`) !== null;
}

export const PREVIEW_ONLY_ATTRS = [
  STUDIO_SOLO_SILENCED_ATTR,
  STUDIO_PREVIEW_UPCOMING_ATTR,
  STUDIO_PREVIEW_LAZY_ATTR,
  PREVIEW_RASTER_ATTR,
  RUNTIME_STAMPED_ATTR,
] as const;

export function applyAuthoredTiming(
  el: Element,
  attrs: ReadonlyArray<readonly [name: string, value: string]>,
): void {
  for (const [name, value] of attrs) el.setAttribute(name, value);
  el.removeAttribute(RUNTIME_STAMPED_ATTR);
}
