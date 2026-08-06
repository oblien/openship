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

/**
 * The Ruby version pinned in `.ruby-version`, a lockfile, or a Gemfile. Returns
 * a bare `X.Y[.Z]` or null. Precedence between the three is the caller's call.
 *
 * A range is not a pin: `ruby "~> 3.3"` returns null rather than guessing.
 */
export function parseRubyVersion(filename: string, content: string): string | null {
  const version = String.raw`(\d+\.\d+(?:\.\d+)?)`;

  switch (filename.toLowerCase()) {
    case ".ruby-version": {
      // `3.3.6`, or `ruby-3.3.6` from the managers that prefix it.
      const m = content.trim().match(new RegExp(`^(?:ruby-)?${version}`));
      return m ? m[1] : null;
    }
    case "gemfile.lock": {
      // "RUBY VERSION\n   ruby 3.3.6p108"
      const m = content.match(new RegExp(String.raw`^RUBY VERSION\s*\n\s*ruby\s+${version}`, "m"));
      return m ? m[1] : null;
    }
    case "gemfile": {
      // The quote right after `ruby` rejects `ruby file:`; anchoring the digits
      // to it rejects `~> 3.3`.
      const m = content.match(new RegExp(String.raw`^\s*ruby\s+['"](?:ruby-)?${version}`, "m"));
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

export const rubyLanguageDetector: LanguageDetector = {
  id: "ruby",
  label: "Ruby",
  // `.ruby-version` carries no deps; it is listed so callers fetch it.
  manifestFiles: ["gemfile", "gemfile.lock", ".ruby-version"],
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
