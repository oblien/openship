import type { LanguageDetector } from "./types";

/**
 * Ruby - `Gemfile` lists gems via `gem 'name', '~> X.Y'` directives.
 * We extract the first quoted argument from each `gem` call and ignore the
 * version constraint (we only need presence for stack detection).
 *
 * `#`-commented lines are skipped, so a gem left in the file as a comment is
 * not reported as installed.
 */
function parseGemfile(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    for (const m of line.matchAll(/gem\s+['"]([^'"]+)['"]/g)) {
      deps[m[1].toLowerCase()] = "*";
    }
  }
  return deps;
}

/**
 * `Gemfile.lock` - the RESOLVED gem set, with exact versions. A Gemfile names
 * direct dependencies only, so transitive gems are invisible to `parseGemfile`.
 *
 * Reads top-level entries of every `specs:` block (GEM, GIT, PATH). Skips the
 * 6-space requirement lines and the DEPENDENCIES section - both list
 * constraints, not what bundler installed.
 */
function parseGemfileLock(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  let inSpecs = false;

  for (const line of content.split("\n")) {
    if (/^ {2}specs:\s*$/.test(line)) {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;

    // Block ends at the blank line before the next section header.
    if (!line.trim() || !/^\s/.test(line)) {
      inSpecs = false;
      continue;
    }

    const spec = line.match(/^ {4}([A-Za-z0-9._-]+) \(([^)]+)\)\s*$/);
    if (spec) deps[spec[1].toLowerCase()] = spec[2];
  }

  return deps;
}

export const rubyLanguageDetector: LanguageDetector = {
  id: "ruby",
  label: "Ruby",
  manifestFiles: ["gemfile", "gemfile.lock"],
  parseManifest(filename, content) {
    switch (filename.toLowerCase()) {
      case "gemfile":
        return parseGemfile(content);
      case "gemfile.lock":
        return parseGemfileLock(content);
      default:
        return {};
    }
  },
};
