import { repos, type Project } from "@repo/db";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { readDeployMeta } from "../projects/project-crud.service";
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

function isHostPath(ref?: string | null): boolean {
  return Boolean(ref?.startsWith("/"));
}

/** Registry/image ref only — never a host path stored on a code-release row. */
export function runtimeImageRef(
  depImageRef: string | null | undefined,
  sdImageRef: string | null | undefined,
): string | null {
  if (depImageRef && !isHostPath(depImageRef)) return depImageRef;
  if (sdImageRef && !isHostPath(sdImageRef)) return sdImageRef;
  return null;
}

/** Independent runtime image pointer and mounted code SHA. */
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

  const [runtimeDep, codeDep, runtimeSds] = await Promise.all([
    runtimeId ? repos.deployment.findById(runtimeId).catch(() => null) : Promise.resolve(null),
    codeId ? repos.deployment.findById(codeId).catch(() => null) : Promise.resolve(null),
    runtimeId ? repos.service.listByDeployment(runtimeId).catch(() => []) : Promise.resolve([]),
  ]);

  const { deployTarget, serverId } = readDeployMeta(project, runtimeDep);
  const server =
    deployTarget === "server" && serverId
      ? ((await repos.server.getInOrganization(serverId, project.organizationId).catch(() => null)) ??
        null)
      : null;

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
      ? { id: server.id || serverId!, name: serverLabel({ ...server, id: server.id || serverId! }) }
      : null,
  };
}
