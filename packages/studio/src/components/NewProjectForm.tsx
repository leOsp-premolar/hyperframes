import { useState, type FormEvent } from "react";
import { Button, FormField as Field, cn, fieldBase, fieldText } from "./ui";
import {
  CUSTOM_RESOLUTION,
  RESOLUTION_PRESETS,
  requestNewProject,
  type NewProjectOutcome,
} from "../utils/newProject";

interface NewProjectFormProps {
  /** Open a project: the one just created, or the existing one a taken name points at. */
  onOpenProject: (id: string) => void;
  onCancel?: () => void;
}

const DEFAULT_PRESET = RESOLUTION_PRESETS[0];

function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className={fieldBase}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        className={fieldText}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * Name, frame size, length and background for a new project. The server owns the
 * rules (allowed names, sizes, clashes) and its message is shown as it is.
 */
export function NewProjectForm({ onOpenProject, onCancel }: NewProjectFormProps) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET.value);
  const [width, setWidth] = useState(String(DEFAULT_PRESET.width));
  const [height, setHeight] = useState(String(DEFAULT_PRESET.height));
  const [duration, setDuration] = useState("10");
  // Empty until chosen: the server owns the default, and a colour input starts at black.
  const [background, setBackground] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Extract<NewProjectOutcome, { ok: false }> | null>(null);

  const chosen = RESOLUTION_PRESETS.find((p) => p.value === preset);
  const existingId = failure?.existingId;
  const custom = preset === CUSTOM_RESOLUTION;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setFailure(null);
    const outcome = await requestNewProject({
      name,
      width: chosen ? chosen.width : Number(width),
      height: chosen ? chosen.height : Number(height),
      durationSeconds: Number(duration),
      ...(background ? { background } : {}),
    });
    setSubmitting(false);
    if (outcome.ok) onOpenProject(outcome.id);
    else setFailure(outcome);
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate aria-label="New project">
      <Field label="Project name" htmlFor="new-project-name">
        <div className={fieldBase} aria-invalid={failure ? true : undefined}>
          <input
            id="new-project-name"
            className={fieldText}
            value={name}
            maxLength={80}
            placeholder="My video"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </Field>
      <Field label="Frame size" htmlFor="new-project-resolution">
        <div className={fieldBase}>
          <select
            id="new-project-resolution"
            className={cn(fieldText, "cursor-pointer bg-transparent")}
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            {RESOLUTION_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM_RESOLUTION}>Custom…</option>
          </select>
        </div>
      </Field>
      {custom && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Width (px)" htmlFor="new-project-width">
            <NumberInput
              id="new-project-width"
              value={width}
              onChange={setWidth}
              min={128}
              max={7680}
              step={2}
            />
          </Field>
          <Field label="Height (px)" htmlFor="new-project-height">
            <NumberInput
              id="new-project-height"
              value={height}
              onChange={setHeight}
              min={128}
              max={7680}
              step={2}
            />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Length (seconds)" htmlFor="new-project-duration">
          <NumberInput
            id="new-project-duration"
            value={duration}
            onChange={setDuration}
            min={1}
            max={3600}
            step={1}
          />
        </Field>
        <Field label="Background" htmlFor="new-project-background">
          <div className={cn(fieldBase, "gap-2")}>
            <input
              id="new-project-background"
              type="color"
              className="h-4 w-6 cursor-pointer border-0 bg-transparent p-0"
              onChange={(e) => setBackground(e.target.value)}
            />
            <span className={cn(fieldText, background && "font-mono")}>
              {background || "Black (default)"}
            </span>
          </div>
        </Field>
      </div>
      <p className="text-step-10 text-text-4">
        The length adjusts to your clips as you edit. Frame rate and format are chosen at export.
      </p>
      {failure && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-step-10 text-danger-ink"
        >
          <span>{failure.error}</span>
          {existingId && (
            <Button
              size="sm"
              variant="secondary"
              type="button"
              onClick={() => onOpenProject(existingId)}
            >
              Open it
            </Button>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!name.trim() || submitting}
        >
          Create project
        </Button>
      </div>
    </form>
  );
}
