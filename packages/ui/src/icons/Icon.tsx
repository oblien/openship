"use client";

import { forwardRef } from "react";
import type { IconName } from "./catalog";
import { IconArtwork, type IconArtworkProps } from "./IconArtwork";
import { useIconConfiguration } from "./IconProvider";
import { iconAssetUrl, resolveIcon } from "./source";

export interface IconProps extends Omit<IconArtworkProps, "src" | "mode" | "fallback"> {
  name: IconName;
}

/** A stable icon ID, independent of the active artwork theme or asset host. */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon({ name, ...props }, ref) {
  const { baseUrl, theme } = useIconConfiguration();
  const resolved = resolveIcon(name, theme);
  const local = resolveIcon(name).asset;

  return (
    <IconArtwork
      {...props}
      ref={ref}
      data-icon={resolved.id}
      src={iconAssetUrl(resolved.asset, baseUrl)}
      mode={resolved.asset.mode}
      bounds={resolved.asset.bounds}
      inset={resolved.asset.inset}
      fallback={{ src: iconAssetUrl(local), mode: local.mode, bounds: local.bounds, inset: local.inset }}
    />
  );
});
