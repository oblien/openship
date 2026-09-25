"use client";

import { forwardRef, useId, useState, type SVGProps } from "react";
import type { IconAsset } from "./types";

interface ArtworkSource {
  readonly src: string;
  readonly mode: IconAsset["mode"];
  readonly bounds?: IconAsset["bounds"];
  readonly inset?: IconAsset["inset"];
}

export interface IconArtworkProps extends Omit<SVGProps<SVGSVGElement>, "children" | "name" | "mode" | "src" | "stroke" | "strokeWidth">, ArtworkSource {
  size?: number | string;
  title?: string;
  fallback?: ArtworkSource;
}

/**
 * Shared image renderer. UI controls use Icon's catalog IDs; this lower-level
 * component also renders previews of user-selected artwork from search results.
 * The SVG viewport preserves CSS sizing, refs, and placement within diagrams.
 */
export const IconArtwork = forwardRef<SVGSVGElement, IconArtworkProps>(function IconArtwork(
  { src, mode, bounds, inset, size = 24, title, fallback, ...props },
  ref,
) {
  const uniqueId = useId();
  const maskId = `icon-${uniqueId}`;
  const titleId = `${maskId}-title`;
  const [failedSource, setFailedSource] = useState<string>();
  const failed = failedSource === src;
  const resolved = failed && fallback ? fallback : { src, mode, bounds, inset };
  const canFallback = !failed && fallback && fallback.src !== src;
  const labelled = Boolean(title || props["aria-label"] || props["aria-labelledby"]);
  // PNG libraries have different amounts of transparent padding. Fit the visible
  // artwork inside the asset's inset (one unit by default). Sparse glyphs such
  // as link arrows can use a larger inset to balance their visual size.
  // Bounds and inset travel with the asset, including CDN and local fallback.
  const box = resolved.bounds;
  const scale = box ? (24 - 2 * (resolved.inset ?? 1)) / Math.max(box[2], box[3]) : 1;
  const artwork = (
    <image
      href={resolved.src}
      x={box ? 12 - (box[0] + box[2] / 2) * scale : 0}
      y={box ? 12 - (box[1] + box[3] / 2) * scale : 0}
      width={24 * scale}
      height={24 * scale}
      preserveAspectRatio="xMidYMid meet"
      onError={canFallback ? () => setFailedSource(src) : undefined}
    />
  );

  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="none"
      focusable="false"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-labelledby={title && !props["aria-label"] ? titleId : undefined}
      {...props}
    >
      {title && <title id={titleId}>{title}</title>}
      {resolved.mode === "color" ? artwork : (
        <>
          <defs>
            <mask id={maskId} x="0" y="0" width="24" height="24" maskUnits="userSpaceOnUse" style={{ maskType: "alpha" }}>
              {artwork}
            </mask>
          </defs>
          <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${maskId})`} />
        </>
      )}
    </svg>
  );
});
