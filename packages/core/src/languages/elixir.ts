import type { LanguageDetector } from "./types";

/**
 * Elixir - `mix.exs` declares deps via `{:name, "~> X.Y"}` tuples inside a
 * `deps/0` function. We extract every `{:atom,` occurrence; the version
 * constraint that follows is ignored (we only need presence).
 *
 * `#`-commented lines are skipped, so a dep left in the file as a comment is
 * not reported as installed.
 *
 * (Umbrella-project root detection - `apps_path: "apps"` - lives under
 * `workspaces/elixir.ts`. They read the same file but answer different
 * questions.)
 */
function parseMixExs(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    for (const m of line.matchAll(/\{:([\w]+),/g)) {
      deps[m[1]] = "*";
    }
  }
  return deps;
}

export const elixirLanguageDetector: LanguageDetector = {
  id: "elixir",
  label: "Elixir",
  manifestFiles: ["mix.exs"],
  parseManifest: (_filename, content) => parseMixExs(content),
};
