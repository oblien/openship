import { outlineModern, type IconName } from "./catalog";
import type { IconAsset } from "./types";

export const LOCAL_ICON_BASE_URL = "/icons";

export interface IconTheme {
  readonly name: string;
  /** Partial themes fall back to the default catalog for unchanged icons. */
  readonly icons: Partial<Record<IconName, IconAsset>>;
}

export const DEFAULT_ICON_THEME: IconTheme = {
  name: "outline-modern",
  icons: outlineModern,
};

export function isIconName(value: string): value is IconName {
  return Object.hasOwn(outlineModern, value);
}

/** Local and CDN installations share filenames; only this prefix changes. */
export function iconAssetUrl(asset: IconAsset, baseUrl = LOCAL_ICON_BASE_URL): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return `${base || LOCAL_ICON_BASE_URL}/${encodeURIComponent(asset.file)}`;
}

export function resolveIcon(name: IconName, theme = DEFAULT_ICON_THEME) {
  // Runtime data can outlive an icon catalog version. Keep a visible fallback
  // rather than treating an unknown ID as a filename or an arbitrary URL.
  const id = isIconName(name) ? name : "help-circle";
  return { id, asset: theme.icons[id] ?? outlineModern[id] };
}
