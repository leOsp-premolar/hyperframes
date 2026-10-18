import { Select, type SelectOption } from "../ui/Select";
import {
  fpsOptionsFor,
  hasPicture,
  hasQuality,
  type ExportFormat,
  type ExportFps,
} from "./exportFormats";

export type ExportQuality = "draft" | "standard" | "high";

const QUALITY_OPTIONS: SelectOption[] = [
  { value: "draft", label: "Draft" },
  { value: "standard", label: "Standard" },
  { value: "high", label: "High Quality" },
];

/** The rate a format exports at: the chosen one, or 30 where the format cannot reach it (GIF). */
export function exportFpsFor(format: ExportFormat, fps: ExportFps): ExportFps {
  return fpsOptionsFor(format).includes(fps) ? fps : 30;
}

/** Frame rate, for exports with a picture. */
export function FrameRateField({
  format,
  fps,
  disabled,
  onChange,
}: {
  format: ExportFormat;
  fps: ExportFps;
  disabled: boolean;
  onChange: (fps: ExportFps) => void;
}) {
  if (!hasPicture(format)) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-step-10 text-text-4">Frame rate</span>
      <Select
        label="Frame rate"
        value={String(exportFpsFor(format, fps))}
        options={fpsOptionsFor(format).map((value) => ({
          value: String(value),
          label: `${value} fps`,
        }))}
        disabled={disabled}
        onCommit={(next) => onChange(Number(next) as ExportFps)}
      />
    </div>
  );
}

/** Quality, for the lossy video encoders only (MOV, GIF, PNG and audio have no such knob). */
export function QualityField({
  format,
  quality,
  disabled,
  onChange,
}: {
  format: ExportFormat;
  quality: ExportQuality;
  disabled: boolean;
  onChange: (quality: ExportQuality) => void;
}) {
  if (!hasQuality(format)) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-step-10 text-text-4">Quality</span>
      <Select
        label="Quality"
        value={quality}
        options={QUALITY_OPTIONS}
        disabled={disabled}
        onCommit={(next) => onChange(next as ExportQuality)}
      />
    </div>
  );
}
