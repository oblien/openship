import { openshipMetadataParser } from "./openship";
import { vercelMetadataParser } from "./vercel";
import { railwayMetadataParser } from "./railway";
import { renderMetadataParser } from "./render";
import type { DeploymentMetadata, MetadataParser } from "./types";

export type {
  DeploymentMetadata,
  DeploymentMetadataSource,
  DeploymentRewrite,
  DeploymentRedirect,
  DeploymentHeaderRule,
  RoutingConfig,
  ProjectCompositeRoute,
  MetadataParser,
} from "./types";
export { openshipMetadataParser } from "./openship";
export { vercelMetadataParser, parseVercelConfig, extractCdTargets, type VercelConfig } from "./vercel";
export { railwayMetadataParser } from "./railway";
export { renderMetadataParser } from "./render";

/**
 * One user-facing message for "the build output directory is missing/unset",
 * shared by every static deploy path (cloud Pages + self-hosted OpenResty) so
 * the wording never drifts. Vercel-style: names the directory and tells the user
 * exactly where to fix it, instead of leaking a runtime's internal error.
 */
export function missingOutputDirectoryMessage(outputDirectory?: string, subject?: string): string {
  const dir = outputDirectory?.trim();
  const who = subject ? ` for "${subject}"` : "";
  return dir
    ? `Couldn't find the build output directory "${dir}"${who} after the build finished. ` +
        `Make sure your build produces "${dir}", or set the correct Output Directory ` +
        `(vercel.json "outputDirectory", or the Output Directory build setting).`
    : `No build output directory is set${who}. Set the Output Directory ` +
        `(vercel.json "outputDirectory", or the build setting) to the folder your build produces — ` +
        `commonly dist, build, out, or public.`;
}

/**
 * All registered metadata parsers, in PRECEDENCE order (highest first).
 * `openship.json` is the NATIVE format and an explicit declaration, so it wins
 * over the imported PaaS formats. `vercel.json` and `railway.toml`/`railway.json`
 * are authoritative build config; `render.yaml` is a fill-only fallback. Add a
 * source by implementing `MetadataParser` and appending it here.
 */
export const METADATA_PARSERS: readonly MetadataParser[] = [
  openshipMetadataParser,
  vercelMetadataParser,
  railwayMetadataParser,
  renderMetadataParser,
];

/** Lower-cased basenames of every metadata file across all parsers. */
export const METADATA_FILES: ReadonlySet<string> = new Set(
  METADATA_PARSERS.flatMap((parser) => parser.files),
);

/**
 * Run every parser over one directory's `{ lowercased-basename -> content }`
 * map and return the non-empty results in precedence order. The consumer folds
 * them over its heuristic detection (see `applyMetadataOverrides` in the stack
 * detector): authoritative sources override, `fillOnly` sources only fill gaps.
 */
export function parseDeploymentMetadata(
  fileContents: Record<string, string>,
): DeploymentMetadata[] {
  const results: DeploymentMetadata[] = [];
  for (const parser of METADATA_PARSERS) {
    const parsed = parser.parse(fileContents);
    if (parsed) results.push(parsed);
  }
  return results;
}
