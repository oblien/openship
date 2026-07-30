import type {
  DeploymentMetadata,
  DeploymentRewrite,
  DeploymentRedirect,
  DeploymentHeaderRule,
  RoutingConfig,
  MetadataParser,
} from "./types";
import { trimmed } from "./text";

/**
 * Map Vercel's `framework` slugs to openship StackIds. Only the slugs that
 * differ from our IDs (or need disambiguation) are listed; anything already
 * matching a StackId passes through untouched via the consumer's own lookup.
 */
const VERCEL_FRAMEWORK_TO_STACK: Record<string, string> = {
  nextjs: "nextjs",
  vite: "vite",
  astro: "astro",
  nuxtjs: "nuxt",
  vue: "vue",
  svelte: "sveltekit",
  sveltekit: "sveltekit",
  remix: "remix",
  gatsby: "gatsby",
  angular: "angular",
  "create-react-app": "cra",
};

/** Raw, normalized view of a vercel.json - pure parse, no app-layer path handling. */
export interface VercelConfig {
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  /** Raw framework slug, lower-cased (map with VERCEL_FRAMEWORK_TO_STACK). */
  framework?: string;
  rewrites?: DeploymentRewrite[];
  redirects?: DeploymentRedirect[];
  headers?: DeploymentHeaderRule[];
  cleanUrls?: boolean;
  trailingSlash?: boolean;
}

/** A rule that matches conditionally (`has`/`missing`) can't be faithfully
 *  reproduced by a plain nginx location, so we drop it rather than apply it
 *  unconditionally (which would be wrong). */
function isConditional(entry: object): boolean {
  return "has" in entry || "missing" in entry;
}

function parseRewrites(value: unknown): DeploymentRewrite[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rewrites: DeploymentRewrite[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object" && !isConditional(entry)) {
      const source = (entry as { source?: unknown }).source;
      const destination = (entry as { destination?: unknown }).destination;
      if (typeof source === "string" && typeof destination === "string") {
        rewrites.push({ source, destination });
      }
    }
  }
  return rewrites.length > 0 ? rewrites : undefined;
}

function parseRedirects(value: unknown): DeploymentRedirect[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const redirects: DeploymentRedirect[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || isConditional(entry)) continue;
    const e = entry as { source?: unknown; destination?: unknown; permanent?: unknown; statusCode?: unknown };
    if (typeof e.source !== "string" || typeof e.destination !== "string") continue;
    const redirect: DeploymentRedirect = { source: e.source, destination: e.destination };
    if (typeof e.permanent === "boolean") redirect.permanent = e.permanent;
    if (typeof e.statusCode === "number") redirect.statusCode = e.statusCode;
    redirects.push(redirect);
  }
  return redirects.length > 0 ? redirects : undefined;
}

function parseHeaders(value: unknown): DeploymentHeaderRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: DeploymentHeaderRule[] = [];
  for (const entry of value) {
    // Like rewrites/redirects, a `has`/`missing` rule can't be reproduced by a
    // plain nginx location — emitting its headers would apply them to EVERY
    // request, not just the matching ones — so drop it rather than mis-apply it.
    if (!entry || typeof entry !== "object" || isConditional(entry)) continue;
    const e = entry as { source?: unknown; headers?: unknown };
    if (typeof e.source !== "string" || !Array.isArray(e.headers)) continue;
    const headers: { key: string; value: string }[] = [];
    for (const h of e.headers) {
      if (h && typeof h === "object") {
        const key = (h as { key?: unknown }).key;
        const val = (h as { value?: unknown }).value;
        if (typeof key === "string" && typeof val === "string") headers.push({ key, value: val });
      }
    }
    if (headers.length > 0) rules.push({ source: e.source, headers });
  }
  return rules.length > 0 ? rules : undefined;
}

/** Assemble the RoutingConfig from parsed pieces, or undefined when empty. */
function buildRoutingConfig(cfg: VercelConfig): RoutingConfig | undefined {
  const routing: RoutingConfig = {};
  if (cfg.rewrites) routing.rewrites = cfg.rewrites;
  if (cfg.redirects) routing.redirects = cfg.redirects;
  if (cfg.headers) routing.headers = cfg.headers;
  if (cfg.cleanUrls !== undefined) routing.cleanUrls = cfg.cleanUrls;
  if (cfg.trailingSlash !== undefined) routing.trailingSlash = cfg.trailingSlash;
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * Parse `vercel.json` into a normalized {@link VercelConfig}. Single source of
 * truth for reading the file - both the metadata parser (build config) and the
 * project-root detector (directory hints) consume this instead of re-parsing.
 * Returns null for invalid JSON.
 */
export function parseVercelConfig(raw: string): VercelConfig | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  // `JSON.parse("null")` succeeds → guard before property access, or a stray
  // `null` file would throw and crash the metadata pipeline (cf. railway.ts).
  if (typeof parsed !== "object" || parsed === null) return null;
  const cfg: VercelConfig = {};
  const installCommand = trimmed(parsed.installCommand);
  const buildCommand = trimmed(parsed.buildCommand);
  const outputDirectory = trimmed(parsed.outputDirectory);
  const framework = trimmed(parsed.framework)?.toLowerCase();
  const rewrites = parseRewrites(parsed.rewrites);
  const redirects = parseRedirects(parsed.redirects);
  const headers = parseHeaders(parsed.headers);
  if (installCommand) cfg.installCommand = installCommand;
  if (buildCommand) cfg.buildCommand = buildCommand;
  if (outputDirectory) cfg.outputDirectory = outputDirectory;
  if (framework) cfg.framework = framework;
  if (rewrites) cfg.rewrites = rewrites;
  if (redirects) cfg.redirects = redirects;
  if (headers) cfg.headers = headers;
  if (typeof parsed.cleanUrls === "boolean") cfg.cleanUrls = parsed.cleanUrls;
  if (typeof parsed.trailingSlash === "boolean") cfg.trailingSlash = parsed.trailingSlash;
  return cfg;
}

/**
 * Directories a shell command `cd`s into, excluding the current dir (`.`/`./`).
 * Shared by the metadata parser (to flag a build that targets another dir) and
 * the project-root detector (to surface those dirs as sub-project hints).
 */
export function extractCdTargets(command?: string): string[] {
  if (!command) return [];
  const targets: string[] = [];
  for (const match of command.matchAll(/(?:^|&&|;|\|)\s*cd\s+['"]?([^'"&;|\s]+)/g)) {
    const target = match[1].replace(/\/+$/, "");
    if (target && target !== ".") targets.push(target);
  }
  return targets;
}

/**
 * Parse `vercel.json` build settings into normalized hints.
 *
 * Directory hints (which subdir a `cd`/outputDirectory points at) are handled
 * separately by the project-root detector's `parseVercelRootDirectories` (which
 * reuses {@link parseVercelConfig}/{@link extractCdTargets}); this parser is only
 * about how the directory it sits in builds and runs.
 */
export const vercelMetadataParser: MetadataParser = {
  source: "vercel",
  files: ["vercel.json"],
  parse(fileContents) {
    const raw = fileContents["vercel.json"];
    if (!raw) return null;

    const cfg = parseVercelConfig(raw);
    if (!cfg) return null;

    const framework = cfg.framework ? VERCEL_FRAMEWORK_TO_STACK[cfg.framework] : undefined;
    const nonLocal =
      extractCdTargets(cfg.buildCommand).length > 0 || extractCdTargets(cfg.installCommand).length > 0;

    const routing = buildRoutingConfig(cfg);

    const metadata: DeploymentMetadata = { source: "vercel" };
    if (cfg.installCommand) metadata.installCommand = cfg.installCommand;
    if (cfg.buildCommand) metadata.buildCommand = cfg.buildCommand;
    if (cfg.outputDirectory) metadata.outputDirectory = cfg.outputDirectory;
    if (framework) metadata.framework = framework;
    if (cfg.rewrites) metadata.rewrites = cfg.rewrites;
    if (routing) metadata.routing = routing;
    if (nonLocal) metadata.nonLocal = true;

    // Nothing actionable → behave as "no metadata" so callers can skip.
    const hasSignal =
      cfg.installCommand || cfg.buildCommand || cfg.outputDirectory || framework || routing;
    return hasSignal ? metadata : null;
  },
};
