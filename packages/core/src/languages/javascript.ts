import type { LanguageDetector, PortDetectionContext } from "./types";

/**
 * JavaScript / TypeScript - package.json is the canonical manifest.
 *
 * We pull deps from `dependencies` + `devDependencies`. The stack detector
 * also has access to the parsed package.json directly (for engines, scripts,
 * etc.) so we deliberately ignore the raw text path for richer reads.
 *
 * Port detection scans the `scripts` block for `--port` / `-p` flags in the
 * usual entry points (start, dev, serve, preview).
 */
function parsePackageJsonDeps(content: string): Record<string, string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {};
  }
  // `JSON.parse("null")` succeeds → guard before property access, or a stray
  // `null` file would throw and crash detection (cf. metadata/railway.ts).
  if (typeof parsed !== "object" || parsed === null) return {};

  const deps = (parsed.dependencies as Record<string, string> | undefined) ?? {};
  const devDeps = (parsed.devDependencies as Record<string, string> | undefined) ?? {};
  return { ...deps, ...devDeps };
}

/**
 * Recover a port from package.json `scripts` entries.
 *
 * Matches `--port 8080`, `--port=8080`, `-p 8080`, `-p=8080` (and the
 * upper-case `--PORT` variant some frameworks accept). Scans start → dev →
 * serve → preview in that order so production scripts win over dev scripts.
 */
function detectPortFromScripts(context: PortDetectionContext): number | null {
  const packageJson = context.packageJson;
  if (!packageJson) return null;

  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  for (const key of ["start", "dev", "serve", "preview"]) {
    const script = scripts[key];
    if (!script) continue;
    const match = script.match(/(?:--port|--PORT|-p)[\s=](\d{2,5})\b/);
    if (match) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port <= 65535) return port;
    }
  }
  return null;
}

export const javascriptLanguageDetector: LanguageDetector = {
  id: "javascript",
  label: "JavaScript / TypeScript",
  manifestFiles: ["package.json"],
  parseManifest: (_filename, content) => parsePackageJsonDeps(content),
  detectPort: detectPortFromScripts,
};
