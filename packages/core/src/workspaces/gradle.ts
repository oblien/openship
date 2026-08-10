import type { WorkspaceDetector } from "./types";

/**
 * Read the argument list of one `include` call, starting just past the keyword.
 *
 * Parenthesized form (`include(...)`) runs to the matching `)`, so a list split
 * over several lines is read whole. The bare form runs to end of line, plus any
 * following lines while the previous one ends in a comma (Groovy's line
 * continuation).
 */
function readIncludeArgs(content: string, start: number): string {
  let i = start;
  while (content[i] === " " || content[i] === "\t") i++;

  if (content[i] === "(") {
    let depth = 0;
    for (let j = i; j < content.length; j++) {
      if (content[j] === "(") depth++;
      else if (content[j] === ")" && --depth === 0) return content.slice(i + 1, j);
    }
    return content.slice(i + 1);
  }

  let args = "";
  for (;;) {
    const newline = content.indexOf("\n", i);
    const line = newline === -1 ? content.slice(i) : content.slice(i, newline);
    args += line;
    if (newline === -1 || !line.trimEnd().endsWith(",")) return args;
    i = newline + 1;
  }
}

/**
 * Gradle multi-project - `settings.gradle` or `settings.gradle.kts` declares
 * the included sub-projects via `include` calls:
 *
 *     include 'app', 'libs:shared'
 *     include(":services:api")
 *     include ":services:worker"
 *     include(
 *         ":feature:login",
 *         ":core:data",
 *     )
 *
 * Gradle uses colon-prefixed paths (`:services:api`); we convert them to
 * slash-separated filesystem paths (`services/api`) since that's how the rest
 * of the codebase references project roots.
 *
 * Comments (`//`, `/* … *\/`) are stripped before matching.
 */
function parseGradleSettings(content: string): string[] {
  // Strip block comments first, then line comments.
  const cleaned = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const paths: string[] = [];
  // `include` as its own call. The word boundary excludes the settings-level
  // `includeBuild` / `includeFlat`, which reference other builds and sibling
  // directories rather than modules of this build.
  const includePattern = /\binclude\b/g;

  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(cleaned)) !== null) {
    const args = readIncludeArgs(cleaned, match.index + match[0].length);
    // Capture every quoted string in this include() call.
    const stringPattern = /"([^"]+)"|'([^']+)'/g;
    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringPattern.exec(args)) !== null) {
      const raw = (stringMatch[1] ?? stringMatch[2] ?? "").trim();
      if (!raw) continue;
      const path = raw.replace(/^:+/, "").replace(/:/g, "/").trim();
      if (path) paths.push(path);
    }
  }

  // Dedupe.
  const seen = new Set<string>();
  return paths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

export const gradleWorkspaceDetector: WorkspaceDetector = {
  id: "gradle",
  label: "Gradle",
  manifestFiles: ["settings.gradle", "settings.gradle.kts"],
  packageManager: "gradle",
  parseSubProjects: parseGradleSettings,
};
