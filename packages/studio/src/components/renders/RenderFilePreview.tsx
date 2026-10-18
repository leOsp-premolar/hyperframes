import { useEffect, useState } from "react";
import { VideoFrameThumbnail } from "../ui/VideoFrameThumbnail";
import { renderKind } from "./exportFormats";
import type { RenderJob } from "./useRenderQueue";

/**
 * The thumbnail of a finished export that is not a video: a GIF plays as itself, while audio and
 * zipped PNG frames have nothing to show inline, so they show what they are.
 */
function RenderFilePreview({
  kind,
  src,
  filename,
}: {
  kind: Exclude<ReturnType<typeof renderKind>, "video">;
  src: string;
  filename: string;
}) {
  if (kind === "gif") {
    return <img src={src} alt="" className="absolute inset-0 w-full h-full object-contain" />;
  }
  const label = kind === "frames" ? "PNG" : (filename.split(".").pop() ?? "").toUpperCase();
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-text-4"
      data-render-kind={kind}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {kind === "audio" ? (
          <path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z" />
        ) : (
          <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
        )}
      </svg>
      <span className="text-step-9 font-medium">{label}</span>
    </div>
  );
}

/** A finished video: a static frame that swaps to the playing video while hovered. */
function VideoPreview({ src, hovered }: { src: string; hovered: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!hovered) setReady(false);
  }, [hovered]);
  return (
    <>
      {/* Live video: fades in over the static frame once it can play */}
      {hovered && (
        <video
          src={src}
          autoPlay
          muted
          loop
          playsInline
          onCanPlay={() => setReady(true)}
          className="absolute inset-0 w-full h-full object-contain transition-opacity duration-150"
          style={{ opacity: ready ? 1 : 0 }}
        />
      )}
      {/* Static frame: visible when not hovering */}
      <div
        className="absolute inset-0 transition-opacity duration-150"
        style={{ opacity: hovered && ready ? 0 : 1 }}
      >
        <VideoFrameThumbnail src={src} />
      </div>
    </>
  );
}

const STATUS_DOT: Record<Exclude<RenderJob["status"], "complete">, string> = {
  rendering: "bg-accent animate-pulse motion-reduce:animate-none",
  failed: "bg-danger-ink",
  cancelled: "bg-text-5",
};

/** What a render row's thumbnail shows: the finished file, or a dot for its state. */
export function RenderThumbnail({
  job,
  src,
  hovered,
}: {
  job: Pick<RenderJob, "status" | "filename">;
  src: string;
  hovered: boolean;
}) {
  if (job.status !== "complete") {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className={`w-2 h-2 rounded-full ${STATUS_DOT[job.status]}`} />
      </div>
    );
  }
  const kind = renderKind(job.filename);
  if (kind === "video") return <VideoPreview src={src} hovered={hovered} />;
  return <RenderFilePreview kind={kind} src={src} filename={job.filename} />;
}
