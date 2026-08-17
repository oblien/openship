import type { Deployment } from "@repo/db";
import { shellQuote } from "@repo/core";
import type { MountedReleaseConfig } from "./mounted-release.config";
import { mountedReleaseHostRoot } from "./mounted-release.config";

/** What `deployment.imageRef` / cleanup must treat this row as. */
export type ReleaseArtifactKind = "docker-image" | "mounted-tree";

export const MOUNTED_TREE_KIND = "mounted-tree" as const;

/** Frozen at enqueue. Execution reads this, not live `project.mountedRelease`. */
export interface MountedReleaseContract {
  artifactKind: typeof MOUNTED_TREE_KIND;
  config: MountedReleaseConfig;
  serviceId?: string;
  serviceName?: string;
  sharedPaths: string[];
  healthPath?: string;
  healthPort?: number;
  reloadCommand?: string;
  commitSha?: string;
  runtimeDeploymentId: string;
  hostRoot: string;
  releaseDir: string;
}

export interface MountedReleaseMeta {
  deploymentLane?: "runtime" | "release";
  artifactKind?: ReleaseArtifactKind;
  mountedReleaseRoot?: string;
  runtimeDeploymentId?: string;
  mountedRelease?: MountedReleaseContract;
}

/** Image tags contain "/" but never start with it. */
export function isFilesystemArtifactRef(ref: string | null | undefined): boolean {
  return Boolean(ref?.startsWith("/"));
}

export function isMountedReleaseRow(dep: Pick<Deployment, "meta">): boolean {
  const meta = (dep.meta ?? {}) as MountedReleaseMeta;
  return meta.deploymentLane === "release" || meta.artifactKind === MOUNTED_TREE_KIND;
}

/** Host path of this code-release tree, or null. Never a Docker image. */
export function mountedReleaseTreeRef(
  dep: Pick<Deployment, "imageRef" | "meta">,
): string | null {
  const meta = (dep.meta ?? {}) as MountedReleaseMeta;
  const candidates = [
    meta.mountedRelease?.releaseDir,
    meta.mountedReleaseRoot,
    dep.imageRef,
  ];
  for (const value of candidates) {
    if (isFilesystemArtifactRef(value)) return value!;
  }
  return null;
}

/** Docker image GC must never see filesystem paths or release-lane rows. */
export function dockerImageGcRef(
  dep: Pick<Deployment, "imageRef" | "meta">,
  ref: string | null | undefined = dep.imageRef,
): string | null {
  if (!ref || isFilesystemArtifactRef(ref) || isMountedReleaseRow(dep)) return null;
  return ref;
}

export function releaseBuilderName(deploymentId: string): string {
  return `openship-release-${deploymentId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

export function releaseDirFor(projectId: string, deploymentId: string): string {
  return `${mountedReleaseHostRoot(projectId)}/releases/${deploymentId}`;
}

function cloneConfig(config: MountedReleaseConfig): MountedReleaseConfig {
  return {
    ...config,
    sharedPaths: config.sharedPaths ? [...config.sharedPaths] : undefined,
    builderCachePaths: config.builderCachePaths ? [...config.builderCachePaths] : undefined,
  };
}

export function freezeMountedReleaseContract(input: {
  config: MountedReleaseConfig;
  commitSha?: string;
  runtimeDeploymentId: string;
  hostRoot: string;
  releaseDir: string;
}): MountedReleaseContract {
  const config = cloneConfig(input.config);
  return {
    artifactKind: MOUNTED_TREE_KIND,
    config,
    serviceId: config.serviceId,
    serviceName: config.serviceName,
    sharedPaths: [...(config.sharedPaths ?? [])],
    healthPath: config.healthPath,
    healthPort: config.healthPort,
    reloadCommand: config.reloadCommand,
    commitSha: input.commitSha,
    runtimeDeploymentId: input.runtimeDeploymentId,
    hostRoot: input.hostRoot,
    releaseDir: input.releaseDir,
  };
}

export function readMountedReleaseSnapshot(
  dep: Pick<Deployment, "meta">,
): MountedReleaseContract | null {
  const meta = (dep.meta ?? {}) as MountedReleaseMeta;
  const snap = meta.mountedRelease;
  if (!snap || !snap.config || !snap.releaseDir || !snap.hostRoot) return null;
  return snap;
}

export function withSnapshotCommit(
  contract: MountedReleaseContract,
  commitSha: string,
): MountedReleaseContract {
  return { ...contract, commitSha };
}

/** `chmod -R a-w` on this tree only — never the project root (that would freeze shared/). */
export function markReleaseTreeReadOnlyCommand(releaseDir: string): string {
  if (!isFilesystemArtifactRef(releaseDir) || releaseDir.includes("..")) {
    throw new Error("Release tree path is not a host directory.");
  }
  return `chmod -R a-w ${shellQuote(releaseDir)}`;
}

/** Make a previously read-only tree deletable, then remove it. */
export function removeReleaseTreeCommand(path: string): string {
  if (!isFilesystemArtifactRef(path) || path.includes("..")) {
    throw new Error("Release path is not a host directory.");
  }
  return `chmod -R u+w ${shellQuote(path)} 2>/dev/null || true; rm -rf ${shellQuote(path)}`;
}

export function stagedReleaseCleanupPaths(opts: {
  ready: boolean;
  incoming: string;
  authDir: string;
  releaseDir: string;
}): string[] {
  const paths = [opts.incoming, opts.authDir];
  if (!opts.ready) paths.push(opts.releaseDir);
  return paths;
}

const PROTECTED_ROOT_NAMES = new Set(["shared", "current", "source.git", "builder-cache", "releases"]);

export function isProtectedMountedReleasePath(hostRoot: string, path: string): boolean {
  const root = hostRoot.replace(/\/+$/, "");
  if (path === root || path === `${root}/` || path === `${root}/current`) return true;
  const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";
  const top = rel.split("/")[0] ?? "";
  return PROTECTED_ROOT_NAMES.has(top) && top !== "releases";
}

/**
 * Incoming/auth leftovers and unused release trees. Never shared/, current,
 * source.git, builder-cache, or an active/retained/in-flight tree.
 */
export function classifyMountedReleaseHostPath(
  hostRoot: string,
  path: string,
  keepReleaseIds: Set<string>,
): "remove" | "keep" {
  const root = hostRoot.replace(/\/+$/, "");
  if (!path.startsWith(`${root}/`) || path.includes("..")) return "keep";
  if (isProtectedMountedReleasePath(root, path)) return "keep";

  const rel = path.slice(root.length + 1);
  const incoming = rel.match(/^\.incoming-(.+)$/);
  if (incoming) return keepReleaseIds.has(incoming[1]!) ? "keep" : "remove";
  const auth = rel.match(/^\.auth-(.+)$/);
  if (auth) return keepReleaseIds.has(auth[1]!) ? "keep" : "remove";

  const release = rel.match(/^releases\/([^/]+)$/);
  if (release) return keepReleaseIds.has(release[1]!) ? "keep" : "remove";
  return "keep";
}

export function retainedMountedReleaseIds(opts: {
  readyNewestFirst: Array<Pick<Deployment, "id" | "pinned" | "meta">>;
  activeReleaseId?: string | null;
  inFlightIds?: Iterable<string>;
  retain: number;
}): Set<string> {
  const keep = new Set<string>();
  if (opts.activeReleaseId) keep.add(opts.activeReleaseId);
  for (const id of opts.inFlightIds ?? []) keep.add(id);

  const retain = Math.max(0, opts.retain);
  let unpinnedKept = 0;
  for (const dep of opts.readyNewestFirst) {
    if (!isMountedReleaseRow(dep)) continue;
    if (dep.pinned) {
      keep.add(dep.id);
      continue;
    }
    if (unpinnedKept < retain) {
      keep.add(dep.id);
      unpinnedKept += 1;
    }
  }
  return keep;
}

/** Image cleanup must destroy a `/` ref as a directory, never `docker rmi`. */
export function cleanupUsesRemoveImage(type: "image" | "artifact" | string, ref: string): boolean {
  if (type !== "image") return false;
  return !isFilesystemArtifactRef(ref);
}
