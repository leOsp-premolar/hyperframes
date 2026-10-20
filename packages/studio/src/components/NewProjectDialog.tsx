import { useRef } from "react";
import { XIcon } from "@phosphor-icons/react";
import { IconButton } from "./ui";
import { useDialogBehavior } from "./ui/useDialogBehavior";
import { NewProjectForm } from "./NewProjectForm";

export function NewProjectDialog({
  onOpenProject,
  onClose,
}: {
  onOpenProject: (id: string) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useDialogBehavior({ open: true, onClose, containerRef });

  return (
    <div
      className="hf-backdrop-in fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={requestClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        tabIndex={-1}
        className="relative bg-surface border border-border-strong rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden outline-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="new-project-title"
          className="px-5 py-3 border-b border-border-strong text-step-11 font-medium text-text-1"
        >
          New project
        </h2>
        <div className="px-5 py-4">
          <NewProjectForm onOpenProject={onOpenProject} onCancel={requestClose} />
        </div>
        {/* After the form in tab order, so the dialog opens with the name field focused. */}
        <IconButton
          aria-label="Close"
          size="sm"
          className="absolute right-3 top-2"
          icon={<XIcon size={14} />}
          onClick={requestClose}
        />
      </div>
    </div>
  );
}
