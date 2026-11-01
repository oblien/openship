import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_TOKENS,
  AppearancePreferencesSchema,
  appearanceVariables,
  createTheme,
  defaultAppearance,
  parseAppearance,
  parseThemeDocument,
} from "./appearance";
const theme = () => createTheme("dim", "personal", "Personal");
describe("portable appearance", () => {
  it("round-trips a theme and its independent overrides without losing mode defaults", () => {
    const custom = {
      ...theme(),
      tokens: {
        "--th-bg-page": "#18212b",
        "--th-input-text": "rgba(255,255,255,.8)",
        "--radius": "12px",
      },
    };
    const prefs = { ...defaultAppearance(custom.id), themes: [custom] };
    expect(parseAppearance(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs);
    expect(appearanceVariables(custom)).toMatchObject({
      "--th-bg-page": "#18212b",
      "--th-card-bg": APPEARANCE_DEFAULTS.dim["--th-card-bg"],
      "--radius": "12px",
    });
  });
  it.each([
    ["--bad", "#123456"],
    ["--th-bg-page", "url(https://tracker.test)"],
    ["--th-text-body", "red; display:none"],
    ["--th-text-body", "</style><script>"],
    ["--radius", "999px"],
    ["--th-card-shadow", "url(https://tracker.test)"],
  ])("rejects unregistered or executable token %s", (key, value) => {
    expect(() => parseThemeDocument({ ...theme(), tokens: { [key]: value } })).toThrow();
  });
  it("preserves exact built-in token values and covers all three modes", () => {
    expect(APPEARANCE_TOKENS).toHaveLength(103);
    for (const base of ["light", "dim", "dark"] as const) {
      expect(() =>
        parseThemeDocument({
          ...createTheme(base, "copy", "Copy"),
          tokens: APPEARANCE_DEFAULTS[base],
        }),
      ).not.toThrow();
    }
  });
  it("rejects unknown document keys, future versions and dangling/duplicate theme ids", () => {
    for (const value of [
      { ...theme(), version: 2 },
      { ...theme(), css: "body {display:none}" },
      { ...theme(), typography: { ...theme().typography, size: 999 } },
    ])
      expect(() => parseThemeDocument(value)).toThrow();
    expect(AppearancePreferencesSchema.safeParse({ ...defaultAppearance("missing") }).success).toBe(
      false,
    );
    expect(
      AppearancePreferencesSchema.safeParse({
        ...defaultAppearance("personal"),
        themes: [theme(), theme()],
      }).success,
    ).toBe(false);
  });
  it("requires a matching embedded WOFF2 asset before selecting a custom font", () => {
    expect(() =>
      parseThemeDocument({ ...theme(), typography: { ...theme().typography, sans: "custom" } }),
    ).toThrow();
    expect(() =>
      parseThemeDocument({
        ...theme(),
        fonts: [{ role: "sans", name: "bad.woff2", data: btoa("<script>bad</script>") }],
      }),
    ).toThrow();
  });
});
it("supports registered token references and rejects cycles through inherited defaults", () => {
  expect(() =>
    parseThemeDocument({ ...theme(), tokens: { "--th-input-bg": "var(--th-bg-page)" } }),
  ).not.toThrow();
  expect(() =>
    parseThemeDocument({
      ...createTheme("light", "cycle", "Cycle"),
      tokens: { "--th-text-title": "var(--th-terminal-black)" },
    }),
  ).toThrow("cycle");
  expect(() =>
    parseThemeDocument({ ...theme(), tokens: { "--th-input-bg": "var(--unregistered)" } }),
  ).toThrow();
});
it("rejects malformed colors and forged WOFF2 headers", () => {
  for (const color of ["rgb( )", "rgb(10)", "rgba(1,2,3,9)", "hsl(100 20 20)"])
    expect(() => parseThemeDocument({ ...theme(), tokens: { "--th-bg-page": color } })).toThrow();
  expect(() =>
    parseThemeDocument({
      ...theme(),
      fonts: [{ role: "sans", name: "fake", data: btoa("wOF2short") }],
    }),
  ).toThrow();
});
it("rejects WOFF2 assets with excessive decoded size before passing them to a font decoder", () => {
  const header = new Uint8Array(48);
  header.set(new TextEncoder().encode("wOF2"));
  const view = new DataView(header.buffer);
  view.setUint32(8, 48);
  view.setUint32(16, 32 * 1024 * 1024);
  const data = btoa(String.fromCharCode(...header));
  expect(() =>
    parseThemeDocument({ ...theme(), fonts: [{ role: "sans", name: "oversized", data }] }),
  ).toThrow();
});
it("keeps generated CSS synchronized with the authoritative palette", () => {
  expect(() =>
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../../scripts/generate-theme-tokens.mjs", import.meta.url)),
      "--check",
    ]),
  ).not.toThrow();
});

it("validates shadow geometry while supporting colors, inset and multiple layers", () => {
  for (const value of [
    "0 4px 12px rgba(0,0,0,.12)",
    "inset 0 0 0 1px #aaaaaa",
    "0 2px 4px #123, 0 4px 12px hsl(0 0% 0% / 20%)",
  ])
    expect(() =>
      parseThemeDocument({ ...theme(), tokens: { "--th-card-shadow": value } }),
    ).not.toThrow();
  for (const value of ["1px", "1px 2px -3px", "1px 2px rgba( )", "1px 2px 3px 4px 5px"])
    expect(() =>
      parseThemeDocument({ ...theme(), tokens: { "--th-card-shadow": value } }),
    ).toThrow();
});
