import { isExportFormat, type ExportFormat, type ExportFps } from "./exportFormats";

const RENDER_SETTINGS_KEY = "hf-studio-render-settings";

export interface PersistedRenderSettings {
  format: ExportFormat;
  quality: "draft" | "standard" | "high";
  fps: ExportFps;
  gpu: boolean;
}

export function getPersistedRenderSettings(): PersistedRenderSettings {
  try {
    const raw = localStorage.getItem(RENDER_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        format: isExportFormat(parsed.format) ? parsed.format : "mp4",
        quality: ["draft", "standard", "high"].includes(parsed.quality)
          ? parsed.quality
          : "standard",
        fps: [24, 30, 60].includes(parsed.fps) ? parsed.fps : 30,
        gpu: parsed.gpu === true,
      };
    }
  } catch {
    /* ignore */
  }
  return { format: "mp4", quality: "standard", fps: 30, gpu: false };
}

export function persistRenderSettings(
  format: PersistedRenderSettings["format"],
  quality: PersistedRenderSettings["quality"],
  fps: PersistedRenderSettings["fps"],
  gpu: boolean = getPersistedRenderSettings().gpu,
): void {
  try {
    localStorage.setItem(RENDER_SETTINGS_KEY, JSON.stringify({ format, quality, fps, gpu }));
  } catch {
    /* ignore */
  }
}
