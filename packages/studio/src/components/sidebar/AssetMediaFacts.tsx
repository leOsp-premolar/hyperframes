import { cn } from "../ui";
import { describeAssetMedia, useAssetMediaInfo } from "../../utils/assetMediaInfo";

/**
 * One line of what a media file is: size, frame rate, codec, sound. Nothing while it is
 * probed or when the probe cannot tell, so a card never shows a guess.
 */
export function AssetMediaFacts({
  projectId,
  asset,
  className,
}: {
  projectId: string;
  asset: string;
  className?: string;
}) {
  const info = useAssetMediaInfo(projectId, asset);
  const parts = info ? describeAssetMedia(info) : [];
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return (
    <div
      data-testid="asset-media-facts"
      className={cn("flex text-[9px] leading-tight text-panel-text-4 tabular-nums", className)}
      title={text}
    >
      <span className="truncate">{text}</span>
    </div>
  );
}
