import type { LanguageDetector, PortDetectionContext } from "./types";

/**
 * JavaScript / TypeScript - package.json is the canonical manifest.
 *
 * We pull deps from `dependencies` + `devDependencies`. The stack detector
 * also has access to the parsed package.json directly (for engines, scripts,
 * etc.) so we deliberately ignore the raw text path for richer reads.
 *
 * Port detection scans the `scripts` block for explicit CLI port flags and
 * inline PORT assignments in the usual entry points (start, dev, serve,
 * preview).
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

function validPort(value: string | undefined): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port > 0 && port <= 65535 ? port : null;
}

/** Read literal leading assignments, never arbitrary PORT= text in arguments. */
function detectInlinePort(script: string): number | null {
  // cmd.exe's common package-script spelling. Keep its case-insensitive names
  // separate from POSIX, where `port` and `PORT` are different variables.
  const windows = script.match(/^set\s+(?:"PORT=(\d+)"|PORT=(\d+))\s*&&/i);
  if (windows) return validPort(windows[1] ?? windows[2]);

  let rest = script.replace(/^(?:cross-env(?:-shell)?|env)\s+/, "");
  let port: number | null = null;
  // Quoted values can contain spaces. Stop as soon as the executable starts;
  // parsing the whole script as assignments would mistake echoed text or
  // --define arguments for the environment the server actually receives.
  const assignment = /^([A-Za-z_]\w*)=(?:"([^"\\]*)"|'([^']*)'|([^\s;&|"'`\\]+))(?:\s+|$)/;
  for (let match = rest.match(assignment); match; match = rest.match(assignment)) {
    if (match[1] === "PORT") port = validPort(match[2] ?? match[3] ?? match[4]);
    rest = rest.slice(match[0].length);
  }
  // An assignment we cannot parse may overwrite PORT later in the prefix.
  if (/^[A-Za-z_]\w*=/.test(rest)) return null;
  return port;
}

/**
 * Recover a port from package.json `scripts` entries.
 *
 * Matches explicit flags (`--port 8080`, `--port=8080`, `-p 8080`) and common
 * inline environment assignments (`PORT=8080`, `cross-env PORT=8080`, and
 * Windows `set PORT=8080 && ...`). Scans start → dev → serve → preview in that
 * order so production scripts win over development scripts.
 */
function detectPortFromScripts(context: PortDetectionContext): number | null {
  const packageJson = context.packageJson;
  if (!packageJson) return null;

  const scripts = (packageJson.scripts ?? {}) as Record<string, unknown>;
  for (const key of ["start", "dev", "serve", "preview"]) {
    const value = scripts[key];
    if (typeof value !== "string") continue;
    const script = value.trim();

    const flagPort = validPort(
      script.match(/(?:^|\s)(?:--port|--PORT|-p)(?:\s+|=)(\d{1,5})(?=$|\s|[;&|])/)?.[1],
    );
    if (flagPort !== null) return flagPort;

    const envPort = detectInlinePort(script);
    if (envPort !== null) return envPort;
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
