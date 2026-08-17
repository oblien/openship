import { repos, type Project } from "@repo/db";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import {
  activeCodeReleaseDeploymentId,
  mountedReleaseBuildMode,
  mountedReleaseConfig,
} from "./mounted-release.config";

export type ProjectLiveRuntime = {
  deploymentId: string | null;
  imageRef: string | null;
  digest: string | null;
  commitSha: string | null;
  builtAt: string | null;
};

export type ProjectLiveCode = {
  deploymentId: string | null;
  sha: string | null;
  strategy: "prebuilt" | "server";
  activatedAt: string | null;
};

export type ProjectLiveState = {
  runtime: ProjectLiveRuntime;
  /** Null when mounted releases are off — this project is runtime-only. */
  code: ProjectLiveCode | null;
  server: { id: string; name: string } | null;
};

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function digestFromRef(ref?: string | null): string | null {
  if (!ref) return null;
  const at = ref.lastIndexOf("@");
  if (at < 0) return null;
  const digest = ref.slice(at + 1);
  return digest.startsWith("sha256:") ? digest : null;
}

function serverLabel(server: { id: string; name?: string | null; sshHost?: string | null }): string {
  return server.name?.trim() || server.sshHost?.trim() || server.id;
}

function runtimeImageRef(
  depImageRef: string | null | undefined,
  sdImageRef: string | null | undefined,
): string | null {
  // Code-release rows store a host path in imageRef; that is not the runtime image.
  if (depImageRef && !depImageRef.startsWith("/")) return depImageRef;
  return sdImageRef ?? depImageRef ?? null;
}

/**
 * Independent runtime and code pointers for the project header.
 *
 * `activeDeploymentId` is the container/image. `activeReleaseDeploymentId` is
 * the mounted code SHA. They move on different schedules and must not be
 * collapsed into one "live" deployment.
 */
export async function resolveProjectLiveState(
  projectId: string,
  organizationId: string,
): Promise<ProjectLiveState> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  return readProjectLiveState(project);
}

export async function readProjectLiveState(project: Project): Promise<ProjectLiveState> {
  const runtimeId = project.activeDeploymentId ?? null;
  const codeId = activeCodeReleaseDeploymentId(project);
  const config = mountedReleaseConfig(project);

  const [runtimeDep, codeDep, runtimeSds, server] = await Promise.all([
    runtimeId ? repos.deployment.findById(runtimeId).catch(() => null) : Promise.resolve(null),
    codeId ? repos.deployment.findById(codeId).catch(() => null) : Promise.resolve(null),
    runtimeId ? repos.service.listByDeployment(runtimeId).catch(() => []) : Promise.resolve([]),
    project.serverId ? repos.server.get(project.serverId).catch(() => null) : Promise.resolve(null),
  ]);

  const sd = runtimeSds.find((row) => row.imageDigest || row.imageRef);
  const imageRef = runtimeImageRef(runtimeDep?.imageRef, sd?.imageRef);

  return {
    runtime: {
      deploymentId: runtimeDep?.id ?? runtimeId,
      imageRef,
      digest: sd?.imageDigest ?? digestFromRef(imageRef),
      commitSha: runtimeDep?.commitSha ?? null,
      builtAt: isoDate(runtimeDep?.updatedAt ?? runtimeDep?.createdAt),
    },
    code: config
      ? {
          deploymentId: codeDep?.id ?? codeId,
          sha: codeDep?.commitSha ?? null,
          strategy: mountedReleaseBuildMode(config),
          activatedAt: isoDate(codeDep?.updatedAt ?? codeDep?.createdAt),
        }
      : null,
    server: server
      ? { id: server.id, name: serverLabel(server) }
      : project.serverId
        ? { id: project.serverId, name: project.serverId }
        : null,
  };
}
