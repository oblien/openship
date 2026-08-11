/**
 * `openship.json` — the native, declarative deploy config (à la vercel.json /
 * railway.toml). A repo-root file that tells Openship how to build, run, route,
 * and scale a project, covering the deploy wizard's options. It's an
 * AUTHORITATIVE OVERLAY: auto-detection runs first, then each field present here
 * overrides it (absent fields keep the detected value). It seeds the wizard and
 * is authoritative for headless deploys (auto-deploy on push, `openship deploy`).
 *
 * This is the typed shape. `parse.ts` validates/coerces raw JSON into it; the
 * published JSON Schema (for editor autocomplete) is generated from the same
 * field set. Every field maps 1:1 to an existing API option — see the docs
 * reference page for the mapping table.
 */

import type { StackId } from "../stacks";
import type { RoutingConfig } from "../metadata/types";
import type { OpenshipReadiness } from "../types";

export type OpenshipRuntime = "bare" | "docker";
export type OpenshipProductionMode = "host" | "static" | "standalone";
export type OpenshipDomainType = "free" | "custom";
export type OpenshipRestart = "no" | "always" | "on-failure" | "unless-stopped";
/** Cloud sizing presets, plus "unlimited" — no caps, the self-hosted default
 *  (the machine itself is the ceiling). */
export type OpenshipResourceTier = "unlimited" | "micro" | "low" | "medium" | "high";

export const OPENSHIP_RUNTIMES: readonly OpenshipRuntime[] = ["bare", "docker"];
export const OPENSHIP_PRODUCTION_MODES: readonly OpenshipProductionMode[] = [
  "host",
  "static",
  "standalone",
];
export const OPENSHIP_DOMAIN_TYPES: readonly OpenshipDomainType[] = ["free", "custom"];
export const OPENSHIP_RESTARTS: readonly OpenshipRestart[] = [
  "no",
  "always",
  "on-failure",
  "unless-stopped",
];
export const OPENSHIP_RESOURCE_TIERS: readonly OpenshipResourceTier[] = [
  "unlimited",
  "micro",
  "low",
  "medium",
  "high",
];

/** Env value: a plain string, or `{ value, secret }` to encrypt it at rest. */
export type OpenshipEnvValue = { value: string; secret?: boolean };
export type OpenshipEnv = Record<string, string | OpenshipEnvValue>;

export interface OpenshipDomain {
  /** Hostname. A `.opsh.io`-style label = a free subdomain; anything with a dot = custom. */
  domain: string;
  /** Which service/exposed port this hostname routes to (defaults to the app port). */
  port?: number;
  /** Path prefix on the target (defaults to "/"). */
  targetPath?: string;
  type?: OpenshipDomainType;
}

export interface OpenshipHealthcheck {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
  disable?: boolean;
}

/**
 * The deploy-time readiness gate lives in ../types alongside ComposeHealthcheck,
 * because a compose SERVICE can carry one too (`service.advanced.readiness`) and
 * both surfaces must reference one definition. Re-exported here so `openship.json`
 * authoring types stay importable from one place.
 */
export type { OpenshipReadiness, OpenshipReadinessFailureAction } from "../types";
export { OPENSHIP_READINESS_FAILURE_ACTIONS } from "../types";

export interface OpenshipService {
  name: string;
  image?: string;
  build?: string;
  dockerfile?: string;
  ports?: string[];
  volumes?: string[];
  dependsOn?: string[];
  env?: OpenshipEnv;
  command?: string;
  restart?: OpenshipRestart;
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  healthcheck?: OpenshipHealthcheck;
  /**
   * Per-service DEPLOY-TIME readiness gate, overriding the top-level `readiness`
   * for this service. Absent ⇒ inherit the project's; neither ⇒ off.
   *
   * Not the same field as `healthcheck` above: that's the Docker HEALTHCHECK the
   * daemon runs on a loop, this is the pipeline's one-shot "did it come up?" and
   * the only one that can fail a deploy.
   */
  readiness?: OpenshipReadiness;
  /** Per-service cpu/memory caps, overriding the top-level `resources` field by
   *  field. Parity with compose `mem_limit` / `deploy.resources.limits`, which
   *  the compose parser now honors. `0` = no limit. */
  resources?: OpenshipResources;
}

/**
 * Per-sub-app overrides for a monorepo. These override what the detector found
 * for the sub-app at `rootDirectory` (matched by path). Only build-shaping
 * fields are supported in v1 — per-app `domain`/`env`/`exposed` are set in the
 * wizard, not here (declare shared vars under the top-level `env`/`domains`).
 */
export interface OpenshipMonorepoApp {
  name: string;
  rootDirectory: string;
  framework?: StackId;
  packageManager?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  buildImage?: string;
  port?: number;
}

export interface OpenshipMonorepo {
  workspace?: { packageManager: string; prepareCommand?: string };
  apps?: OpenshipMonorepoApp[];
}

/** Cloud sizing tier OR an explicit production resource allocation. */
export interface OpenshipResources {
  tier?: OpenshipResourceTier;
  cpuCores?: number;
  memoryMb?: number;
  diskMb?: number;
}

export interface OpenshipConfig {
  // ── Build ──
  framework?: StackId;
  packageManager?: string;
  rootDirectory?: string;
  /**
   * Where the compose file lives, when it isn't at the project root — either the
   * file itself (`"deploy/stack.yml"`, which also covers non-standard filenames)
   * or the directory holding it (`"deploy/docker-compose"`). Declaring this makes
   * the project a compose/services deploy.
   */
  composePath?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  buildImage?: string;
  productionPaths?: string[];
  /**
   * Paths the app keeps across deploys. Either the short app form — a path
   * relative to the app root (`"storage"`, `"public/uploads"`) — or full compose
   * syntax (`"uploads:/app/storage"`, `"/srv/data:/app/storage"`). Omit to inherit
   * the framework's defaults (Laravel keeps `storage/`); declare `[]` to opt out.
   * Compose services keep declaring their own under `services[].volumes`.
   */
  volumes?: string[];
  // ── Runtime ──
  runtime?: OpenshipRuntime;
  productionMode?: OpenshipProductionMode;
  port?: number;
  // ── Env ──
  env?: OpenshipEnv;
  // ── Domains + routing ──
  domains?: OpenshipDomain[];
  routes?: RoutingConfig;
  // ── Resources ──
  resources?: OpenshipResources;
  // ── Deploy-time readiness gate (all off by default) ──
  readiness?: OpenshipReadiness;
  // ── Services (compose) ──
  services?: OpenshipService[];
  // ── Monorepo ──
  monorepo?: OpenshipMonorepo;
}

export interface ParseResult {
  /** Valid fields, partial — only what parsed cleanly. null if `raw` isn't an object. */
  config: OpenshipConfig | null;
  /** Hard validation failures (bad type / unknown enum / out-of-range). */
  errors: string[];
  /** Soft issues (unknown keys) — non-fatal; the field is ignored. */
  warnings: string[];
}
