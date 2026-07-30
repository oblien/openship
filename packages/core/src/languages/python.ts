import type { LanguageDetector } from "./types";

/**
 * Python - three manifests in the wild:
 *
 *   - requirements.txt:    pip-format `name==version` lines (plus -e, -r flags)
 *   - pyproject.toml:      PEP 621 [project] dependencies, Poetry [tool.poetry.dependencies],
 *                          and PEP 621 optional-dependencies groups
 *   - Pipfile:             pipenv [packages] / [dev-packages] sections
 *
 * All three parsers normalize package names to lowercase with `-` replaced by
 * `_` so downstream detection lookups match regardless of which dialect the
 * project uses.
 */

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/-/g, "_");
}

function parseRequirementsTxt(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) deps[normalizeName(m[1])] = line.slice(m[1].length) || "*";
  }
  return deps;
}

/**
 * Contents of the array literal assigned to `key` in a TOML table body, or null
 * when the key is absent. Scans for the closing `]` tracking quote state and
 * nesting, so brackets inside values (`"uvicorn[standard]"`) don't end it.
 */
function sliceArrayValue(body: string, key: string): string | null {
  const open = body.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[`));
  if (!open || open.index === undefined) return null;

  const from = open.index + open[0].length;
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return body.slice(from, i);
  }
  return null;
}

function parsePyprojectToml(content: string): Record<string, string> {
  const deps: Record<string, string> = {};

  // PEP 621 standard: [project].dependencies = ["flask>=2.0", "sqlalchemy"]
  const project = content.match(/\[project\]([\s\S]*?)(?=\n\[|$)/);
  const pep621 = project ? sliceArrayValue(project[1], "dependencies") : null;
  if (pep621 !== null) {
    const items = pep621.matchAll(/["']([^"']+)["']/g);
    for (const item of items) {
      const m = item[1].match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (m) deps[normalizeName(m[1])] = "*";
    }
  }

  // Poetry: [tool.poetry.dependencies]. Body terminates at `\n[` (next section header)
  // to avoid mis-stopping on `[` inside inline-table values like
  // `flask = {extras = ["redis"]}`.
  const poetry = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (poetry) {
    for (const line of poetry[1].split("\n")) {
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/);
      if (m && m[1] !== "python") deps[normalizeName(m[1])] = "*";
    }
  }

  // Optional dependencies - both PEP 621 standard form
  //     [project.optional-dependencies]
  //       api = ["fastapi", "uvicorn[standard]"]
  // and the per-group sub-table form
  //     [project.optional-dependencies.api]
  // are scanned for quoted package names.
  const optGroups = content.matchAll(
    /\[project\.optional-dependencies(?:\.[^\]]+)?\]([\s\S]*?)(?=\n\[|$)/g,
  );
  for (const group of optGroups) {
    const items = group[1].matchAll(/["']([^"']+)["']/g);
    for (const item of items) {
      const m = item[1].match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (m) deps[normalizeName(m[1])] = "*";
    }
  }

  return deps;
}

function parsePipfile(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  // Terminate at `\n[` (next section header) so `[` inside inline tables
  // like `flask = {extras = ["redis"]}` doesn't truncate the section.
  const sections = content.matchAll(/\[(packages|dev-packages)\]([\s\S]*?)(?=\n\[|$)/g);
  for (const section of sections) {
    for (const line of section[2].split("\n")) {
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/);
      if (m) deps[normalizeName(m[1])] = "*";
    }
  }
  return deps;
}

export const pythonLanguageDetector: LanguageDetector = {
  id: "python",
  label: "Python",
  manifestFiles: ["requirements.txt", "pyproject.toml", "pipfile"],
  parseManifest(filename, content) {
    switch (filename.toLowerCase()) {
      case "requirements.txt":
        return parseRequirementsTxt(content);
      case "pyproject.toml":
        return parsePyprojectToml(content);
      case "pipfile":
        return parsePipfile(content);
      default:
        return {};
    }
  },
};
