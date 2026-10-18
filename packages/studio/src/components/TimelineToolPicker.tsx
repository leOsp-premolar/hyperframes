import type { ReactNode } from "react";
import { ArrowLineLeft, ArrowLineRight, CaretDown } from "@phosphor-icons/react";
import { usePlayerStore } from "../player";
import { Scissors } from "../icons/SystemIcons";
import { Menu, MenuItem } from "./ui";
import { cn } from "./ui/cn";
import { flatIdle } from "./timelineToolbarStyles";

function SelectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M2 0.5L10 6L6.5 6.5L8.5 11L6.5 11.5L4.5 7L2 9Z" />
    </svg>
  );
}

/** A clip window with arrows inside it: the source slides, the clip stays. */
function SlipIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M4 3v10M12 3v10M6 8h4M6 8l1.5-1.5M6 8l1.5 1.5M10 8L8.5 6.5M10 8L8.5 9.5" />
    </svg>
  );
}

/** Two clips meeting at an edit point that moves both ways. */
function RollIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M8 2v12M2 8h4M2 8l1.5-1.5M2 8l1.5 1.5M14 8h-4M14 8l-1.5-1.5M14 8l-1.5 1.5" />
    </svg>
  );
}

interface ToolRow {
  label: string;
  shortcut: string;
  icon: ReactNode;
  active: boolean;
  run: () => void;
}

/** One button for the active timeline tool; its menu switches tools or selects clips around the playhead. */
export function TimelineToolPicker({ showSelectAroundPlayhead = true }) {
  const activeTool = usePlayerStore((s) => s.activeTool);
  const store = () => usePlayerStore.getState();
  const rows: ToolRow[] = [
    {
      label: "Select",
      shortcut: "V",
      icon: <SelectIcon />,
      active: activeTool === "select",
      run: () => store().setActiveTool("select"),
    },
    {
      label: "Split",
      shortcut: "B",
      icon: <Scissors size={16} />,
      active: activeTool === "razor",
      run: () => store().setActiveTool("razor"),
    },
    {
      label: "Slip",
      shortcut: "Y",
      icon: <SlipIcon />,
      active: activeTool === "slip",
      run: () => store().setActiveTool("slip"),
    },
    {
      label: "Roll",
      shortcut: "U",
      icon: <RollIcon />,
      active: activeTool === "roll",
      run: () => store().setActiveTool("roll"),
    },
  ];
  if (showSelectAroundPlayhead) {
    rows.push(
      {
        label: "Select leftward",
        shortcut: "[",
        icon: <ArrowLineLeft size={16} aria-hidden="true" />,
        active: false,
        run: () => store().selectLeftward(),
      },
      {
        label: "Select rightward",
        shortcut: "]",
        icon: <ArrowLineRight size={16} aria-hidden="true" />,
        active: false,
        run: () => store().selectRightward(),
      },
    );
  }
  const current = rows.find((row) => row.active) ?? rows[0];
  return (
    <Menu
      aria-label="Timeline tools"
      trigger={
        <button
          type="button"
          aria-label={`Timeline tool: ${current.label}`}
          className={cn(flatIdle, "gap-0.5")}
        >
          {current.icon}
          <CaretDown size={10} weight="bold" aria-hidden="true" />
        </button>
      }
    >
      {rows.map((row) => (
        <MenuItem
          key={row.label}
          shortcut={row.shortcut}
          onClick={row.run}
          data-active={row.active || undefined}
          className={row.active ? "bg-press text-text-0" : undefined}
        >
          <span className="flex items-center gap-2">
            {row.icon}
            {row.label}
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}
