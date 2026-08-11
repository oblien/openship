/**
 * API-side adapters onto the canonical @repo/core deployment-class resolver.
 *
 * The core resolver is pure and structural; these thin adapters map the two
 * concrete shapes the API carries — a persisted project row and a frozen
 * deployment snapshot — onto `DeploymentClassSignals` and return the resolved
 * `{source, build, workload}` triple. Every consumer reads the class through
 * one of these so the git-clone gate, the runtime plan, preflight and the
 * read-side classifiers can never drift.
 *
 * Imports ONLY from @repo/core (a leaf), so it can be imported by
 * `pinned-artifacts.ts`, `build.service.ts` and the project/service modules
 * without an import cycle.
 */

import {
  resolveDeploymentClass,
  resolveWorkload,
  toBuildKind,
  toSourceKind,
  toWorkloadType,
  type DeploymentClass,
  type WorkloadType,
} from "@repo/core";

/** Structural subset of a persisted project row the class is resolved from. */
export interface ProjectClassInput {
  framework?: string | null;
  gitProvider?: string | null;
  gitUrl?: string | null;
  localPath?: string | null;
  hasBuild?: boolean | null;
  hasServer?: boolean | null;
  sourceKind?: string | null;
  buildKind?: string | null;
  workloadType?: string | null;
}

/** Resolve a project row's deployment class. */
export function projectToClass(p: ProjectClassInput): DeploymentClass {
  return resolveDeploymentClass({
    framework: p.framework,
    gitProvider: p.gitProvider,
    gitUrl: p.gitUrl,
    localPath: p.localPath,
    hasBuild: p.hasBuild,
    hasServer: p.hasServer,
    sourceKind: toSourceKind(p.sourceKind),
    buildKind: toBuildKind(p.buildKind),
    workloadType: toWorkloadType(p.workloadType),
  });
}

/**
 * Structural subset of a deployment snapshot. Carries BOTH the frozen triple
 * (`source`/`build`/`workload`, present on snapshots written on or after #538)
 * AND the legacy fields — so a snapshot frozen BEFORE the migration, which has
 * no triple, still classifies correctly by deriving from its own
 * `repoUrl`/`framework`/`hasBuild`/`hasServer`/source flags. This is what makes
 * rollback of a pre-#538 release safe.
 */
export interface SnapshotClassInput {
  repoUrl?: string | null;
  framework?: string | null;
  localPath?: string | null;
  hasBuild?: boolean | null;
  hasServer?: boolean | null;
  uploadWorkspaceId?: string | null;
  releaseVersion?: string | null;
  releaseRepo?: string | null;
  /** Frozen triple — absent on pre-#538 snapshots (then null → derive). */
  source?: string | null;
  build?: string | null;
  workload?: string | null;
}

/** Resolve a deployment snapshot's deployment class. */
export function snapshotToClass(s: SnapshotClassInput): DeploymentClass {
  return resolveDeploymentClass({
    framework: s.framework,
    // The snapshot's clone URL IS the git signal — a non-empty repoUrl means
    // "source is git" regardless of whether a build step runs (issue #538-A).
    gitUrl: s.repoUrl,
    localPath: s.localPath,
    hasBuild: s.hasBuild,
    hasServer: s.hasServer,
    isUpload: !!s.uploadWorkspaceId,
    isRelease: !!(s.releaseVersion || s.releaseRepo),
    sourceKind: toSourceKind(s.source),
    buildKind: toBuildKind(s.build),
    workloadType: toWorkloadType(s.workload),
  });
}

/**
 * The one read-side workload classifier. Given anything that carries the
 * explicit `workloadType` column plus the legacy `hasServer` boolean, return
 * the resolved runtime workload. Shares `resolveWorkload` with the full
 * resolver, so a read-side check and a deploy-time decision can never disagree.
 */
export function deploymentWorkload(x: {
  hasServer?: boolean | null;
  workloadType?: string | null;
}): WorkloadType {
  return resolveWorkload(x.workloadType, x.hasServer);
}
