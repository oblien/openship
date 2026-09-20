/**
 * Deployment class — the single source of truth for the THREE orthogonal axes
 * that describe how a project deploys. Historically two boolean columns
 * (`hasBuild`, `hasServer`) each conflated two independent concerns, which is
 * how a Dockerfile app lost its clone token (issue #538, case A) and a portless
 * worker got routed through static file-serve and failed (case B).
 *
 *   source   — WHERE the deployable content comes from:
 *                "git"    → a repository we must clone (needs a token)
 *                "upload" → files staged out of band (folder upload / local dir);
 *                           no clone
 *                "image"  → a prebuilt artifact (registry image, pinned image, or
 *                           a release/dist tarball); no clone, no source build
 *   build    — HOW the image/artifact is produced:
 *                "dockerfile" → the repo ships its own Dockerfile
 *                "buildpack"  → openship runs the stack's install/build commands
 *                "static"     → a static site (files served by the edge)
 *                "prebuilt"   → nothing to build (image/release deploys verbatim)
 *   workload — WHAT runs after deploy:
 *                "web"    → a long-running server with a listening port + route
 *                "worker" → a long-running container with NO port and NO route
 *                           (queue consumer, cron, bot, …)
 *                "static" → no process; files served by the edge
 *
 * `resolveDeploymentClass` is `explicit override ?? derived-from-legacy-flags`,
 * the repo's established "null = derive" idiom (cf. `project.runtimeMode`). The
 * derivation reproduces the exact pre-#538 behaviour when no explicit value is
 * set, so every existing row and every frozen deployment snapshot classifies as
 * it did before — `worker` is reachable ONLY via an explicit `workloadType`.
 *
 * Pure, no I/O — lives in @repo/core so the db schema, API request validation,
 * openship.json config and the deploy pipeline all resolve identically.
 */

import { normalizeFramework, STACKS, type StackDefinition, type StackId } from "./stacks";

export type SourceKind = "git" | "image" | "upload";
export type BuildKind = "dockerfile" | "buildpack" | "static" | "prebuilt";
export type WorkloadType = "web" | "worker" | "static";

export const SOURCE_KINDS = ["git", "image", "upload"] as const;
export const BUILD_KINDS = ["dockerfile", "buildpack", "static", "prebuilt"] as const;
export const WORKLOAD_TYPES = ["web", "worker", "static"] as const;

export interface DeploymentClass {
  source: SourceKind;
  build: BuildKind;
  workload: WorkloadType;
}

/**
 * The raw signals a class is resolved from. Adapters (project row / deployment
 * snapshot / openship.json) populate whatever they have; every field is optional
 * so a partial/legacy source still resolves sensibly. The three `*Kind` fields
 * are the EXPLICIT overrides — when set (non-null) they win over derivation.
 */
export interface DeploymentClassSignals {
  framework?: string | null;
  gitProvider?: string | null;
  gitUrl?: string | null;
  localPath?: string | null;
  /** Source was uploaded out of band (folder upload / staged local dir). */
  isUpload?: boolean;
  /** Source is a release/dist artifact (gitProvider "release" / a resolved release version). */
  isRelease?: boolean;
  /** A prebuilt image is present with nothing to build (registry image / pinned image). */
  hasImageArtifact?: boolean;
  hasBuild?: boolean | null;
  hasServer?: boolean | null;
  /** Explicit overrides — null/undefined means "derive". */
  sourceKind?: SourceKind | null;
  buildKind?: BuildKind | null;
  workloadType?: WorkloadType | null;
}

function nonEmpty(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function isStaticFramework(framework: string): boolean {
  if (!(framework in STACKS)) return false;
  return (STACKS[framework as StackId] as StackDefinition).category === "static";
}

function deriveSource(s: DeploymentClassSignals): SourceKind {
  const provider = (s.gitProvider ?? "").trim().toLowerCase();
  // Uploaded / staged local source is never cloned.
  if (s.isUpload || provider === "upload" || provider === "local") return "upload";
  // A release/dist tarball and a prebuilt registry/pinned image both deploy an
  // artifact verbatim — no repo, no clone. Grouped under "image" (prebuilt).
  if (s.isRelease || provider === "release" || s.hasImageArtifact) return "image";
  // The load-bearing git signal is a real clone URL, NOT the provider column —
  // `gitProvider` defaults to "github" even on projects that never clone.
  if (nonEmpty(s.gitUrl)) return "git";
  if (provider === "github" || provider === "gitlab" || provider === "bitbucket") return "git";
  // A local directory with no repo is staged, not cloned. Unknown → no clone
  // (nothing to fetch), matching the pre-#538 "no repoUrl" behaviour.
  return "upload";
}

function deriveBuild(s: DeploymentClassSignals, source: SourceKind, workload: WorkloadType): BuildKind {
  const framework = normalizeFramework(s.framework);
  if (framework === "docker") return "dockerfile";
  // Nothing to build: a prebuilt image or a release/dist deploys verbatim.
  if (source === "image") return "prebuilt";
  if (workload === "static" || isStaticFramework(framework)) return "static";
  return "buildpack";
}

/**
 * The workload formula in ONE place: an explicit `workloadType` override wins;
 * otherwise the legacy `hasServer` boolean maps `false → static`, everything
 * else `web`. `worker` is therefore reachable ONLY through an explicit override,
 * so every legacy row/snapshot classifies exactly as it did pre-#538. Read-side
 * classifiers (`deploymentWorkload`) share this so they can't drift from
 * `resolveDeploymentClass`.
 */
export function resolveWorkload(
  workloadType: string | null | undefined,
  hasServer: boolean | null | undefined,
): WorkloadType {
  return toWorkloadType(workloadType) ?? (hasServer === false ? "static" : "web");
}

/**
 * Resolve the deployment class from signals. Explicit `*Kind` overrides win;
 * otherwise each axis is derived to reproduce the exact pre-#538 behaviour, so
 * legacy rows/snapshots (which carry only `hasBuild`/`hasServer`/`framework`)
 * classify unchanged. `worker` is reachable ONLY through an explicit
 * `workloadType`.
 */
export function resolveDeploymentClass(s: DeploymentClassSignals): DeploymentClass {
  const workload = resolveWorkload(s.workloadType, s.hasServer);
  const source: SourceKind = s.sourceKind ?? deriveSource(s);
  const build: BuildKind = s.buildKind ?? deriveBuild(s, source, workload);
  return { source, build, workload };
}

/** Does this deployment's SOURCE require cloning a git repository? The one
 *  question issue #538-A got wrong: a Dockerfile build (build="dockerfile",
 *  hasBuild=false) still clones its repo for the build context. Purely a
 *  function of the source axis — how the artifact is BUILT is irrelevant to
 *  whether the code must be fetched. */
export function classNeedsGitSource(cls: DeploymentClass): boolean {
  return cls.source === "git";
}

/** Narrow a free-text column/value to a valid WorkloadType, else undefined. */
export function toWorkloadType(value: string | null | undefined): WorkloadType | undefined {
  return value === "web" || value === "worker" || value === "static" ? value : undefined;
}

export function toSourceKind(value: string | null | undefined): SourceKind | undefined {
  return value === "git" || value === "image" || value === "upload" ? value : undefined;
}

export function toBuildKind(value: string | null | undefined): BuildKind | undefined {
  return value === "dockerfile" || value === "buildpack" || value === "static" || value === "prebuilt"
    ? value
    : undefined;
}
