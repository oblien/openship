/** Shared theme format, editable token registry and validation for every client. */
import { z } from "zod";
import defaults from "./appearance-defaults.json";

export const APPEARANCE_DEFAULTS = defaults;
export const THEME_MODES = ["light", "dim", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const APPEARANCE_MAX_THEMES = 32;
export const APPEARANCE_MAX_BYTES = 1024 * 1024;
export const APPEARANCE_FONT_OPTIONS = {
  gellix: "'Gellix', 'SF Arabic', system-ui, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', 'SF Arabic', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
  systemMono: "ui-monospace, SFMono-Regular, Consolas, monospace",
} as const;
export type AppearanceTokenKey = keyof typeof defaults.light;
export type AppearanceTokenGroup =
  | "surfaces"
  | "text"
  | "controls"
  | "status"
  | "effects"
  | "scales";
export const APPEARANCE_TOKENS = Object.keys(defaults.light).map((key) => ({
  key: key as AppearanceTokenKey,
  type: key === "--radius" ? "length" : key.includes("shadow") ? "shadow" : "color",
  group: (key.startsWith("--st-")
    ? "status"
    : /^--th-(on|sf)-/.test(key)
      ? "scales"
      : key.includes("shadow") || key === "--radius" || key.includes("overlay")
        ? "effects"
        : /^--th-(text|terminal)-/.test(key)
          ? "text"
          : /^--th-(btn|input|spinner)-/.test(key)
            ? "controls"
            : "surfaces") as AppearanceTokenGroup,
}));
const registry = new Map(APPEARANCE_TOKENS.map((token) => [token.key as string, token]));

function validColor(value: string): boolean {
  if (value === "transparent" || /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value))
    return true;
  const match = /^(rgb|hsl)a?\(([^)]+)\)$/i.exec(value);
  if (!match) return false;
  const channels = match[2]
    .trim()
    .replace(/\s*\/\s*/g, ",")
    .split(/[\s,]+/);
  if (
    channels.length < 3 ||
    channels.length > 4 ||
    channels.some((channel) => !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(channel))
  )
    return false;
  return channels.every((channel, index) => {
    const percent = channel.endsWith("%");
    const number = parseFloat(channel);
    if (index === 3) return number >= 0 && number <= (percent ? 100 : 1);
    if (match[1].toLowerCase() === "hsl")
      return index === 0
        ? !percent && Math.abs(number) <= 3600
        : percent && number >= 0 && number <= 100;
    return number >= 0 && number <= (percent ? 100 : 255);
  });
}

function validShadow(value: string): boolean {
  if (value === "none") return true;
  const shadows = value.split(/,(?![^()]*\))/);
  if (shadows.length > 4) return false;
  return shadows.every((shadow) => {
    const parts = shadow.trim().match(/(?:rgba?|hsla?)\([^)]*\)|[^\s]+/g) ?? [];
    let colors = 0;
    let insets = 0;
    const lengths: number[] = [];
    for (const part of parts) {
      if (part === "inset") {
        insets++;
        continue;
      }
      if (validColor(part)) {
        colors++;
        continue;
      }
      if (!/^(?:0|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem))$/.test(part)) return false;
      lengths.push(parseFloat(part));
    }
    return (
      colors <= 1 &&
      insets <= 1 &&
      lengths.length >= 2 &&
      lengths.length <= 4 &&
      (lengths.length < 3 || lengths[2] >= 0)
    );
  });
}

/** Accept data values only. Never accept CSS declarations, URLs or arbitrary variables. */
export function validAppearanceToken(key: string, value: string): boolean {
  const token = registry.get(key);
  if (!token || value.length > 512 || /[;{}<>\\]|url\s*\(|expression\s*\(/i.test(value))
    return false;
  value = value.trim();
  if (THEME_MODES.some((mode) => defaults[mode][token.key] === value)) return true;
  const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (reference) return registry.get(reference)?.type === token.type;
  if (token.type === "length")
    return /^(?:0|(?:[0-9]|[12][0-9]|3[0-2])(?:\.\d{1,2})?px|(?:0|1)(?:\.\d{1,2})?rem)$/.test(
      value,
    );
  if (token.type === "shadow") return validShadow(value);
  return validColor(value);
}
const tokenOverrides = z.record(z.string(), z.string().max(512)).superRefine((values, ctx) => {
  for (const [key, value] of Object.entries(values))
    if (!validAppearanceToken(key, value))
      ctx.addIssue({ code: "custom", path: [key], message: "Unknown token or unsupported value" });
});
/** WOFF2 bounds are checked before handing imported bytes to the font decoder. */
export function isThemeFontData(value: string): boolean {
  try {
    const decoded = atob(value);
    const uint32 = (offset: number) =>
      decoded.charCodeAt(offset) * 0x1000000 +
      (decoded.charCodeAt(offset + 1) << 16) +
      (decoded.charCodeAt(offset + 2) << 8) +
      decoded.charCodeAt(offset + 3);
    return (
      decoded.startsWith("wOF2") &&
      decoded.length >= 48 &&
      decoded.length <= 256 * 1024 &&
      uint32(8) === decoded.length &&
      uint32(16) > 0 &&
      uint32(16) <= 16 * 1024 * 1024
    );
  } catch {
    /* diagnostics-ignore: Invalid base64 is ordinary theme-input validation. */ return false;
  }
}
export const ThemeDocumentSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(64),
    base: z.enum(THEME_MODES),
    tokens: tokenOverrides,
    typography: z
      .object({
        sans: z.enum(["gellix", "system", "serif", "custom"]),
        mono: z.enum(["mono", "systemMono", "custom"]),
        size: z.number().min(12).max(20),
        monoSize: z.number().min(10).max(20),
        lineHeight: z.number().min(1.3).max(2),
        weight: z.number().int().min(300).max(700),
      })
      .strict(),
    fonts: z
      .array(
        z
          .object({
            role: z.enum(["sans", "mono"]),
            name: z.string().min(1).max(80),
            data: z
              .string()
              .max(350_000)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/)
              .refine(isThemeFontData, "Upload a WOFF2 font"),
          })
          .strict(),
      )
      .max(2)
      .default([]),
  })
  .strict()
  .superRefine((theme, ctx) => {
    const effective: Record<string, string> = { ...defaults[theme.base], ...theme.tokens };
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cyclic = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      for (const match of effective[key]?.matchAll(/var\((--[\w-]+)/g) ?? [])
        if (registry.has(match[1]) && cyclic(match[1])) return true;
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    const cyclicKey = Object.keys(effective).find(cyclic);
    if (cyclicKey)
      ctx.addIssue({
        code: "custom",
        path: ["tokens", cyclicKey],
        message: "Theme token references must not form a cycle",
      });
    if (["light", "dim", "dark", "system"].includes(theme.id))
      ctx.addIssue({ code: "custom", path: ["id"], message: "Reserved theme id" });
    if (new Set(theme.fonts.map((font) => font.role)).size !== theme.fonts.length)
      ctx.addIssue({
        code: "custom",
        path: ["fonts"],
        message: "Only one font per role is allowed",
      });
    for (const role of ["sans", "mono"] as const)
      if (theme.typography[role] === "custom" && !theme.fonts.some((font) => font.role === role))
        ctx.addIssue({ code: "custom", path: ["fonts"], message: `Missing ${role} font` });
  });
export type ThemeDocument = z.infer<typeof ThemeDocumentSchema>;
export const AppearancePreferencesSchema = z
  .object({
    version: z.literal(1),
    active: z.string().max(64),
    themes: z.array(ThemeDocumentSchema).max(APPEARANCE_MAX_THEMES),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.themes.map((theme) => theme.id)).size !== value.themes.length)
      ctx.addIssue({ code: "custom", path: ["themes"], message: "Theme ids must be unique" });
    if (
      !["light", "dim", "dark", "system"].includes(value.active) &&
      !value.themes.some((theme) => theme.id === value.active)
    )
      ctx.addIssue({ code: "custom", path: ["active"], message: "Select an existing theme" });
    if (new TextEncoder().encode(JSON.stringify(value)).length > APPEARANCE_MAX_BYTES)
      ctx.addIssue({ code: "custom", message: "Themes and font assets must fit within 1 MiB" });
  });
export type AppearancePreferences = z.infer<typeof AppearancePreferencesSchema>;
/** Structural JSON schema for REST, SDK and MCP; semantic validation uses the same parser. */
export const APPEARANCE_JSON_SCHEMA = z.toJSONSchema(AppearancePreferencesSchema, {
  unrepresentable: "any",
});
export function parseAppearance(value: unknown): AppearancePreferences {
  return AppearancePreferencesSchema.parse(value);
}
export function parseThemeDocument(value: unknown): ThemeDocument {
  return ThemeDocumentSchema.parse(value);
}
export function defaultAppearance(active = "light"): AppearancePreferences {
  return { version: 1, active, themes: [] };
}
export function createTheme(base: ThemeMode, id: string, name: string): ThemeDocument {
  return {
    version: 1,
    id,
    name,
    base,
    tokens: {},
    typography: {
      sans: "gellix",
      mono: "mono",
      size: 16,
      monoSize: 13,
      lineHeight: 1.5,
      weight: 400,
    },
    fonts: [],
  };
}
export function appearanceTheme(preferences: AppearancePreferences): ThemeDocument | undefined {
  return preferences.themes.find((theme) => theme.id === preferences.active);
}
export function appearanceVariables(theme?: ThemeDocument): Record<string, string> {
  if (!theme) return {};
  return {
    ...defaults[theme.base],
    ...theme.tokens,
    "--font-sans":
      theme.typography.sans === "custom"
        ? `"Openship-${theme.id}-sans", system-ui, 'SF Arabic', sans-serif`
        : APPEARANCE_FONT_OPTIONS[theme.typography.sans],
    "--font-mono":
      theme.typography.mono === "custom"
        ? `"Openship-${theme.id}-mono", monospace`
        : APPEARANCE_FONT_OPTIONS[theme.typography.mono],
    "--appearance-font-size": `${theme.typography.size}px`,
    "--appearance-mono-size": `${theme.typography.monoSize}px`,
    "--appearance-line-height": `${theme.typography.lineHeight}`,
    "--appearance-font-weight": `${theme.typography.weight}`,
  };
}

/** Both the editor and CLI accept one portable theme or an entire theme library. */
export function mergeAppearanceImport(
  value: unknown,
  current: AppearancePreferences,
): AppearancePreferences {
  if (value && typeof value === "object" && Object.hasOwn(value, "active"))
    return parseAppearance(value);
  const theme = parseThemeDocument(value);
  return parseAppearance({
    ...current,
    active: theme.id,
    themes: [...current.themes.filter((item) => item.id !== theme.id), theme],
  });
}
