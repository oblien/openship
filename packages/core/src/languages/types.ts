/**
 * Language detector registry - one entry per programming-language family.
 *
 * Each entry knows how to read that family's manifests (requirements.txt,
 * Cargo.toml, go.mod, …) into a uniform dependency map, and optionally how
 * to recover a port from contextual signals (e.g. JS scripts, Dockerfile EXPOSE).
 *
 * Downstream the stack detector iterates the registry to merge deps from
 * every present manifest and to resolve a default port. Adding a language
 * family is one new file + one registry entry - `stack-detector.ts` doesn't
 * change.
 */

/** Context passed to optional port detectors. */
export interface PortDetectionContext {
  /** Already-parsed package.json (JS) - undefined for non-JS callers. */
  packageJson?: Record<string, unknown>;
  /** Lower-cased filename → text content map for the project root. */
  fileContents?: Record<string, string>;
}

/** Framework discovery can use development tools; role suggestions follow the managed install. */
export type DependencyPurpose = "detection" | "roles";

export interface LanguageDetector {
  /** Stable identifier - used in telemetry and detector lookups. */
  id: string;
  /** Human label shown in logs ("JavaScript / TypeScript", "Python", "Go"). */
  label: string;
  /**
   * Lower-cased basenames of manifest files this language knows how to parse.
   * The stack detector reads the file map once and dispatches each match to
   * `parseManifest`.
   */
  manifestFiles: readonly string[];
  /**
   * Parse one manifest's text into a dependency map. Keys are lowercased
   * package names; values are version strings or "*" when only presence is
   * known. Return {} when the file can't be parsed or carries no deps.
   *
   * `filename` is provided so a single language module can handle multiple
   * manifests with a switch (Python's requirements.txt vs pyproject.toml vs Pipfile).
   * `purpose` defaults to detection. A language whose managed install excludes
   * development dependencies can filter those for role suggestions here.
   */
  parseManifest(filename: string, content: string, purpose?: DependencyPurpose): Record<string, string>;
  /**
   * Recover a default port from contextual signals. Return null when this
   * language has nothing to say - the next detector in the registry runs.
   *
   * Only JS (--port flags in package.json scripts) and Docker (EXPOSE) implement
   * this today. Most languages omit it.
   */
  detectPort?(context: PortDetectionContext): number | null;
}
