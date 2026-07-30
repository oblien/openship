/**
 * Deployment-metadata parser registry - one entry per industry-standard config
 * file that describes how a project builds and runs (vercel.json, render.yaml,
 * netlify.toml, Procfile, …).
 *
 * Mirrors the `workspaces/` and `languages/` registries: one file per source, a
 * registry in `index.ts`, and a normalized shape every parser returns. The stack
 * detector folds these hints over its own heuristic detection so a repo that
 * already tells a PaaS how to build it deploys the same way on openship.
 *
 * Adding a source is exactly one file + one registry entry + a fixture test -
 * the detector doesn't change.
 */

import type { ProxySettings } from "../proxy-settings";

export type DeploymentMetadataSource =
  | "openship"
  | "vercel"
  | "railway"
  | "render"
  | "netlify"
  | "heroku"
  | "nixpacks";

export interface DeploymentRewrite {
  /** Incoming path pattern (source syntax is source-specific; kept verbatim). */
  source: string;
  /** Where it maps to (e.g. "/index.html" for SPA fallback). */
  destination: string;
}

/** A redirect rule (HTTP 3xx), mirroring vercel.json `redirects`. */
export interface DeploymentRedirect {
  source: string;
  destination: string;
  /** Vercel shorthand: permanent=true → 308, else 307. `statusCode` wins if set. */
  permanent?: boolean;
  statusCode?: number;
}

/** A response-header rule, mirroring vercel.json `headers`. */
export interface DeploymentHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * Normalized routing config extracted from a repo's platform config
 * (`vercel.json`, `netlify.toml`/`_redirects`, …). Reproduces the documented
 * config semantics (not a platform's edge/serverless runtime). Persisted on the
 * project and compiled to the reverse-proxy (OpenResty) at deploy time.
 */
export interface RoutingConfig {
  rewrites?: DeploymentRewrite[];
  redirects?: DeploymentRedirect[];
  headers?: DeploymentHeaderRule[];
  /** Strip `.html` extensions (serve `/about` for `/about.html`). */
  cleanUrls?: boolean;
  /** Enforce (true) or remove (false) trailing slashes. */
  trailingSlash?: boolean;
  /** Project-level reverse-proxy tunables (client_max_body_size, timeouts,
   *  buffering, gzip) rendered into every vhost this project owns. Overrides
   *  the server default; overridden per-service. */
  proxy?: ProxySettings;
}

/**
 * A domain served by path fan-out across services: one root upstream at `/` plus
 * extra path-prefix locations, each pointing at a (possibly different) service.
 * Persisted on the project so the composition is RE-EMITTED from live upstreams
 * on every redeploy (like `RoutingConfig`), not just at first publish. Populated
 * by a cross-server migration that adopted a multi-upstream vhost
 * (e.g. `api.onvo.me` `/` → web, `/v3` → api).
 */
export interface ProjectCompositeRoute {
  hostname: string;
  isCustomDomain: boolean;
  /** Service served at `/` (the route's primary upstream). */
  rootServiceId: string;
  /** Extra path-prefix locations, resolved to their service's upstream at deploy. */
  locations: { pathPrefix: string; serviceId: string }[];
}

/**
 * Normalized build/run hints extracted from one metadata file. Every field is
 * optional - a parser sets only what its file actually declares.
 */
export interface DeploymentMetadata {
  source: DeploymentMetadataSource;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  startCommand?: string;
  /** Framework slug as named by the source (e.g. vercel "vite"/"nextjs"). Mapped to a StackId by the consumer. */
  framework?: string;
  env?: Record<string, string>;
  /** SPA/redirect rules (also surfaced structured under `routing.rewrites`). */
  rewrites?: DeploymentRewrite[];
  /**
   * Full routing config (rewrites/redirects/headers/cleanUrls/trailingSlash) —
   * persisted on the project and compiled to OpenResty at deploy time.
   */
  routing?: RoutingConfig;
  /**
   * When true, the build/install commands `cd` into a DIFFERENT directory
   * (e.g. a root `vercel.json` whose buildCommand is "cd frontend && npm run
   * build"). Such commands describe another directory's build, so the consumer
   * must NOT apply this file's build-shaping fields to the directory it sits in.
   */
  nonLocal?: boolean;
  /**
   * When true, these hints only FILL fields the detector left empty; they never
   * override a value the detector already resolved. Used for weak signals
   * (e.g. render.yaml's startCommand) that shouldn't beat a package.json script.
   */
  fillOnly?: boolean;
}

export interface MetadataParser {
  source: DeploymentMetadataSource;
  /** Lower-cased basenames this parser reads. Looked up in the fileContents map. */
  files: readonly string[];
  /**
   * Parse from a map of `{ lowercased-basename -> content }`. Return `null` when
   * none of the parser's files are present or nothing useful was declared.
   */
  parse(fileContents: Record<string, string>): DeploymentMetadata | null;
}
