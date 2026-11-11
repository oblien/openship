import type { ThemeMode } from "@repo/core";

export const THEME_COOKIE = "openship-theme";
export const THEME_HEADER = "x-openship-theme";

/** Only the base palette travels with requests; personal tokens/fonts stay local. */
export interface ThemePreference {
  active: ThemeMode | "system";
  resolved: ThemeMode;
}

export function parseThemeCookie(value: string | null | undefined): ThemePreference | null {
  const match = /^(light|dim|dark|system):(light|dim|dark)$/.exec(value ?? "");
  if (!match || (match[1] !== "system" && match[1] !== match[2])) return null;
  return { active: match[1] as ThemePreference["active"], resolved: match[2] as ThemeMode };
}

export function themeCookieValue(active: string, resolved: ThemeMode): string {
  const preference = ["light", "dim", "dark", "system"].includes(active) ? active : resolved;
  return `${preference}:${resolved}`;
}
