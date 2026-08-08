import { dockerLanguageDetector } from "./docker";
import { elixirLanguageDetector } from "./elixir";
import { goLanguageDetector } from "./go";
import { javaLanguageDetector } from "./java";
import { javascriptLanguageDetector } from "./javascript";
import { phpLanguageDetector } from "./php";
import { pythonLanguageDetector } from "./python";
import { rubyLanguageDetector } from "./ruby";
import { rustLanguageDetector } from "./rust";
import type { LanguageDetector, PortDetectionContext } from "./types";

export type { LanguageDetector, PortDetectionContext } from "./types";

/** Ruby's version files carry no deps, so this sits outside the detector API. */
export { parseRubyVersion } from "./ruby";

/**
 * All registered language detectors. Add a language family by:
 *   1. Implementing `LanguageDetector` in its own file under languages/.
 *   2. Appending it here.
 *   3. Adding a fixture test in `apps/api/test/lib/language-detectors.test.ts`.
 *
 * The stack detector iterates this registry to:
 *   - merge deps from every present manifest, and
 *   - resolve a port from contextual signals (first non-null wins).
 */
export const LANGUAGE_DETECTORS: readonly LanguageDetector[] = [
  javascriptLanguageDetector,
  pythonLanguageDetector,
  goLanguageDetector,
  rustLanguageDetector,
  rubyLanguageDetector,
  phpLanguageDetector,
  javaLanguageDetector,
  elixirLanguageDetector,
  dockerLanguageDetector,
] as const;

/**
 * Union of every manifest filename across all detectors. Consumers
 * (prepare.service.ts) iterate this to know which files to fetch from the repo.
 *
 * Derived from the registry - adding a language automatically adds its
 * manifests to this list.
 */
export const LANGUAGE_MANIFEST_FILES: readonly string[] = Array.from(
  new Set(LANGUAGE_DETECTORS.flatMap((d) => d.manifestFiles.map((f) => f.toLowerCase()))),
);

/**
 * Merge deps from every present manifest into a single map.
 *
 * Keys are lowercased package identifiers; later languages don't overwrite
 * earlier ones (Object.assign semantics) - typically deps don't collide across
 * languages, so this just unions cleanly.
 */
export function collectDependencies(
  fileContents: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (fileContents) {
    for (const [k, v] of Object.entries(fileContents)) normalized[k.toLowerCase()] = v;
  }

  const deps: Record<string, string> = {};
  for (const detector of LANGUAGE_DETECTORS) {
    for (const manifest of detector.manifestFiles) {
      const content = normalized[manifest];
      if (!content) continue;
      Object.assign(deps, detector.parseManifest(manifest, content));
    }
  }
  return deps;
}

/**
 * Ask each language detector for a port until one answers. Returns null when
 * no detector recognizes a port signal (caller falls back to the stack's
 * `defaultPort`).
 */
export function detectPort(context: PortDetectionContext): number | null {
  for (const detector of LANGUAGE_DETECTORS) {
    if (!detector.detectPort) continue;
    const port = detector.detectPort(context);
    if (port !== null) return port;
  }
  return null;
}
