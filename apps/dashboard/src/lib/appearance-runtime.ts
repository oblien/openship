import { reportCaughtError } from "@repo/core/diagnostics";
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_TOKENS,
  appearanceTheme,
  appearanceVariables,
  parseAppearance,
  type AppearancePreferences,
  type ThemeMode,
} from "@repo/core";
import { THEME_COOKIE, themeCookieValue, type ThemePreference } from "./theme-cookie";

export const APPEARANCE_CACHE_POINTER = "openship-appearance-owner";
export const APPEARANCE_CHANGED = "openship:appearance-changed";
export const appearanceCacheKey = (owner: string) => `openship-appearance-v1:${owner}`;
export function cachedAppearance(key: string): AppearancePreferences | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parseAppearance(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function resolveAppearance(
  preferences: AppearancePreferences,
  desktop: boolean,
  dark: boolean,
): ThemeMode {
  const custom = appearanceTheme(preferences);
  return (
    custom?.base ??
    (preferences.active === "system"
      ? dark
        ? desktop
          ? "dim"
          : "dark"
        : "light"
      : (preferences.active as ThemeMode))
  );
}
const fontFaces = new Map<string, FontFace>();
export function applyAppearance(preferences: AppearancePreferences, mode: ThemeMode): void {
  const root = document.documentElement;
  const custom = appearanceTheme(preferences);
  const variables = appearanceVariables(custom);
  for (const token of APPEARANCE_TOKENS) root.style.removeProperty(token.key);
  for (const key of [
    "--font-sans",
    "--font-mono",
    "--appearance-font-size",
    "--appearance-mono-size",
    "--appearance-line-height",
    "--appearance-font-weight",
  ])
    root.style.removeProperty(key);
  root.setAttribute("data-theme", mode);
  for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
  root.style.fontSize = variables["--appearance-font-size"] ?? "";
  root.style.backgroundColor =
    custom?.tokens["--th-bg-page"] ?? APPEARANCE_DEFAULTS[mode]["--th-bg-page"];
  for (const [key, face] of fontFaces) {
    if (!custom?.fonts.some((font) => key === `${custom.id}:${font.role}:${font.data}`)) {
      document.fonts.delete(face);
      fontFaces.delete(key);
    }
  }
  for (const font of custom?.fonts ?? []) {
    const key = `${custom!.id}:${font.role}:${font.data}`;
    if (fontFaces.has(key)) continue;
    const face = new FontFace(
      `Openship-${custom!.id}-${font.role}`,
      `url(data:font/woff2;base64,${font.data})`,
    );
    fontFaces.set(key, face);
    document.fonts.add(face);
    void face.load().then(
      () => {
        if (fontFaces.get(key) === face) window.dispatchEvent(new Event(APPEARANCE_CHANGED));
      },
      (error) => {
        reportCaughtError(error, "dashboard/appearance/font");
        // Invalid/unsupported fonts retain the configured system/Arabic fallback.
        document.fonts.delete(face);
        if (fontFaces.get(key) === face) fontFaces.delete(key);
      },
    );
  }
  window.dispatchEvent(new Event(APPEARANCE_CHANGED));
}
export function cacheAppearance(
  key: string,
  preferences: AppearancePreferences,
  mode: ThemeMode,
): void {
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
    localStorage.setItem(
      `${key}:paint`,
      JSON.stringify({
        mode,
        active: preferences.active,
        variables: appearanceVariables(appearanceTheme(preferences)),
      }),
    );
    localStorage.setItem(APPEARANCE_CACHE_POINTER, key);
  } catch (error) {
    reportCaughtError(
      error,
      "dashboard/appearance/cache",
    ); /* Account persistence still succeeds when browser storage is unavailable. */
  }
  persistThemeCookie(preferences, mode);
}

export function persistThemeCookie(preferences: AppearancePreferences, mode: ThemeMode): void {
  try {
    const secure = window.location.protocol === "https:" ? ";secure" : "";
    document.cookie = `${THEME_COOKIE}=${themeCookieValue(preferences.active, mode)};path=/;max-age=31536000;samesite=lax${secure}`;
  } catch {
    /* diagnostics-ignore: Browser cookie restrictions must not prevent appearance changes. */
  }
}
/** Serializable pre-hydration painter. Only typed CSS values on known properties are applied. */
export function bootAppearance(
  defaults: Record<ThemeMode, { "--th-bg-page": string }>,
  tokens: Array<{ key: string; type: string }>,
  initialTheme?: ThemePreference | null,
) {
  try {
    const desktop = !!(window as { desktop?: { isDesktop?: boolean } }).desktop?.isDesktop;
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    let legacy: string | null = null;
    let snapshot: { mode?: string; active?: string; variables?: Record<string, unknown> } | null = null;
    try {
      legacy = localStorage.getItem("theme");
      const owner = localStorage.getItem("openship-appearance-owner");
      const raw = owner?.startsWith("openship-appearance-v1:")
        ? localStorage.getItem(`${owner}:paint`)
        : null;
      snapshot = raw && raw.length < 64_000 ? JSON.parse(raw) : null;
    } catch {
      // The cookie still supplies a palette when storage is blocked or corrupt.
    }
    const preference = initialTheme?.active ?? legacy;
    let mode =
      preference === "light" || preference === "dim" || preference === "dark"
        ? preference
        : preference === "system" || desktop
          ? dark
            ? desktop
              ? "dim"
              : "dark"
            : "light"
          : "light";
    // A failed cache write must not override a newer saved cookie with old tokens.
    const compatible =
      snapshot &&
      ["light", "dim", "dark"].includes(snapshot.mode ?? "") &&
      (!initialTheme ||
        (snapshot.mode === initialTheme.resolved &&
          (initialTheme.active !== "system" || snapshot.active === "system")))
        ? snapshot
        : null;
    if (compatible && !initialTheme)
      mode =
        compatible.active === "system"
          ? dark
            ? desktop
              ? "dim"
              : "dark"
            : "light"
          : (compatible.mode as ThemeMode);
    const root = document.documentElement;
    root.setAttribute("data-theme", mode);
    const allowed: Record<string, string> = Object.fromEntries(
      tokens.map((token) => [
        token.key,
        token.type === "shadow"
          ? "box-shadow"
          : token.type === "length"
            ? "border-radius"
            : "color",
      ]),
    );
    Object.assign(allowed, {
      "--font-sans": "font-family",
      "--font-mono": "font-family",
      "--appearance-font-size": "font-size",
      "--appearance-mono-size": "font-size",
      "--appearance-line-height": "line-height",
      "--appearance-font-weight": "font-weight",
    });
    for (const [key, value] of Object.entries(compatible?.variables ?? {}))
      if (
        Object.hasOwn(allowed, key) &&
        typeof value === "string" &&
        value.length <= 512 &&
        !/[;{}<>\\]|url\s*\(/i.test(value) &&
        CSS.supports(allowed[key], value)
      )
        root.style.setProperty(key, value);
    root.style.fontSize = root.style.getPropertyValue("--appearance-font-size");
    root.style.backgroundColor =
      root.style.getPropertyValue("--th-bg-page") || defaults[mode as ThemeMode]["--th-bg-page"];
  } catch {
    // Retain the server-rendered palette if a browser API is unavailable.
  }
}
