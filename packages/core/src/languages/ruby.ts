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

export const rubyLanguageDetector: LanguageDetector = {
  id: "ruby",
  label: "Ruby",
  manifestFiles: ["gemfile"],
  parseManifest: (_filename, content) => parseGemfile(content),
};
