import { useMemo } from "react";
import { usePlayerStore } from "../../player";
import { Select } from "../ui/Select";
import { describeRange, markedRange, type ExportRange } from "./exportFormats";

/** The timeline's in/out range, live; null when no point is set. */
export function useMarkedRange(): ExportRange | null {
  const inPoint = usePlayerStore((s) => s.inPoint);
  const outPoint = usePlayerStore((s) => s.outPoint);
  const duration = usePlayerStore((s) => s.duration);
  return useMemo(() => markedRange(inPoint, outPoint, duration), [inPoint, outPoint, duration]);
}

/** Whole timeline, or the in/out range the timeline marks (I and O). */
export function ExportRangeField({
  marked,
  useMarked,
  disabled,
  onChange,
}: {
  marked: ExportRange | null;
  useMarked: boolean;
  disabled: boolean;
  onChange: (useMarked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-step-10 text-text-4">Range</span>
      <Select
        label="Range"
        value={useMarked && marked ? "marked" : "whole"}
        options={[
          { value: "whole", label: "Whole timeline" },
          {
            value: "marked",
            label: marked
              ? `In to out: ${describeRange(marked)}`
              : "In to out (set I and O on the timeline)",
            disabled: !marked,
          },
        ]}
        disabled={disabled}
        onCommit={(next) => onChange(next === "marked")}
      />
    </div>
  );
}
