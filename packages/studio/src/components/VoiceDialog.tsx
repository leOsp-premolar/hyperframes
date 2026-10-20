import { useRef } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@phosphor-icons/react";
import { IconButton } from "./ui";
import { useDialogBehavior } from "./ui/useDialogBehavior";
import { VoiceForm, type VoiceDone } from "./VoiceForm";

export function VoiceDialog({
  projectId,
  onDone,
  onClose,
}: {
  projectId: string;
  onDone: (outcome: VoiceDone) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useDialogBehavior({ open: true, onClose, containerRef });

  // On the body, so the Assets panel it opens from does not become its frame.
  return createPortal(
    <div
      className="hf-backdrop-in fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={requestClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-dialog-title"
        tabIndex={-1}
        className="relative bg-surface border border-border-strong rounded-xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden outline-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="voice-dialog-title"
          className="px-5 py-3 border-b border-border-strong text-step-11 font-medium text-text-1"
        >
          Generate voice
        </h2>
        <div className="px-5 py-4">
          <VoiceForm projectId={projectId} onDone={onDone} onCancel={requestClose} />
        </div>
        {/* After the form in tab order, so the dialog opens with the text field focused. */}
        <IconButton
          aria-label="Close"
          size="sm"
          className="absolute right-3 top-2"
          icon={<XIcon size={14} />}
          onClick={requestClose}
        />
      </div>
    </div>,
    document.body,
  );
}
