import { posix } from "node:path";
import {
  ensureCloudProjectVolume, resolveExecutor, scopedVolumeName, transferVolume,
  type BackupExecutor, type BackupSource, type DockerRuntime, type ServiceHandle,
  type TransferCompression, type TransferEndpoint, type TransferMode,
} from "@repo/adapters";
import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import type { DirectLink } from "./direct-transfer";
import { isMovableBind } from "./migration-preflight";
import { migrationTargetPath, migrationTargetVolume } from "./migration-storage";
import { probeOneVolume } from "./volume-conflict";

export interface MigrationDataItem {
  key: string;
  kind: "volume" | "bind" | "path";
  source: string;
  dest: string;
  serviceName: string;
  src: TransferEndpoint;
  dst: TransferEndpoint;
}

/** Only these volumes may be removed by rollback. Existing volumes (even an
 * explicitly approved overwrite) are never removed just because planning failed. */
export interface MigrationDataPlan {
  items: MigrationDataItem[];
  createdVolumes: string[];
  managedPaths: string[];
}

type ConflictAction = "override" | "clone" | "keep";

export function migrationUsesDirectLink(input: {
  sameServer: boolean; managedSource: boolean; managedTarget: boolean; mode?: TransferMode;
}): boolean {
  return !input.sameServer && input.mode !== "stream" &&
    !(input.managedSource && input.managedTarget && (!input.mode || input.mode === "auto"));
}

function validateSource(kind: MigrationDataItem["kind"], source: string) {
  if (typeof source !== "string" || !source || (kind === "volume" ? !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source) : !isMovableBind(source)))
    throw new AppError("Choose a valid source volume or an absolute application data path", 400, "INVALID_MIGRATION_PATH");
}

function dataHandle(projectId: string, slug: string, name: string, source: string): ServiceHandle {
  return { id: `${projectId}:${name}`, projectId, projectSlug: slug, name,
    image: null, env: {}, volumes: [`${source}:/data`], containerId: null,
    namespaceVolumes: false, includeFileBinds: true };
}

/** Resume repairs a source; the reviewed destination never changes with it. */
export async function resolveMigrationDataItem(input: {
  key: string; kind: MigrationDataItem["kind"]; source: string; dest: string;
  serviceName: string; projectId: string; projectSlug: string;
  sourceExecutor: BackupExecutor; targetExecutor: BackupExecutor;
}): Promise<MigrationDataItem> {
  validateSource(input.kind, input.source);
  validateSource(input.kind, input.dest);
  const sourceHandle = dataHandle(input.projectId, input.projectSlug, input.serviceName, input.source);
  const targetHandle = dataHandle(input.projectId, input.projectSlug, input.serviceName, input.dest);
  const source = (await input.sourceExecutor.listSources(sourceHandle)).find(item => item.target === "/data");
  const destination = (await input.targetExecutor.listSources(targetHandle)).find(item => item.target === "/data");
  if (!source || !destination) throw new Error("Could not resolve the migration's data endpoints");
  return { key: input.key, kind: input.kind, source: input.source, dest: input.dest,
    serviceName: input.serviceName,
    src: { exec: input.sourceExecutor, handle: sourceHandle, sourceId: source.id, isFile: source.isDirectory === false },
    dst: { exec: input.targetExecutor, handle: targetHandle, sourceId: destination.id } };
}

/** Both transports use this plan: live mounts, one physical writer, explicit
 * conflict decisions, and the same paths that the target deployment mounts. */
export async function planMigrationData(input: {
  projectId: string; organizationId: string;
  sourceRuntime: DockerRuntime; targetRuntime: DockerRuntime;
  scannedContainerIds: Record<string, string>; sameServer: boolean; managedTarget: boolean;
  volumeStrategies: Record<string, "reuse" | "copy">;
  customPaths: Array<{ source: string; dest: string }>;
  conflictResolution: Record<string, ConflictAction>;
  log: (message: string) => void;
}): Promise<MigrationDataPlan> {
  const project = await repos.project.findByIdInOrganization(input.projectId, input.organizationId);
  if (!project) throw new Error("The migration's target project is unavailable");
  const services = await repos.service.listByProject(project.id);
  const sourceExecutor = resolveExecutor("docker", input.sourceRuntime);
  const targetExecutor = input.sameServer ? sourceExecutor : resolveExecutor("docker", input.targetRuntime);
  const candidates: Array<{ item: MigrationDataItem; action?: ConflictAction }> = [];

  const add = async (serviceName: string, source: BackupSource, handle: ServiceHandle,
    kind: MigrationDataItem["kind"], dest: string, action?: ConflictAction) => {
    validateSource(kind, source.source);
    validateSource(kind, dest);
    const targetHandle = dataHandle(project.id, project.slug, serviceName, dest);
    const targetSource = (await targetExecutor.listSources(targetHandle)).find(item => item.target === "/data");
    if (!targetSource) throw new Error(`Could not resolve the destination for ${source.source}`);
    candidates.push({ action, item: {
      key: kind === "path" ? `path:${source.source}:${dest}` : `${kind}:${source.source}`,
      kind, source: source.source, dest, serviceName,
      src: { exec: sourceExecutor, handle, sourceId: source.id, isFile: source.isDirectory === false },
      dst: { exec: targetExecutor, handle: targetHandle, sourceId: targetSource.id },
    } });
  };

  for (const service of services) {
    // Repo-only additions have no source container; they deploy normally.
    const containerId = input.scannedContainerIds[service.name];
    if (!containerId || (input.sameServer && input.volumeStrategies[service.name] !== "copy")) continue;
    if (!await input.sourceRuntime.inspectContainer(containerId))
      throw new Error(`Source container ${service.name} disappeared; scan it again`);
    const handle: ServiceHandle = { ...dataHandle(project.id, project.slug, service.name, "unused"),
      id: service.id, volumes: service.volumes ?? [], containerId };
    for (const source of await sourceExecutor.listSources(handle)) {
      if (source.type !== "volume" && source.type !== "bind") continue;
      if (source.type === "bind") {
        if (input.sameServer && !input.managedTarget) continue;
        if (!isMovableBind(source.source)) {
          if (input.managedTarget) throw new Error(`Host mount ${source.source} cannot be imported into a managed server`);
          continue;
        }
      }
      const action = source.type === "volume" ? input.conflictResolution[source.source] : undefined;
      const dest = source.type === "volume"
        ? input.sameServer ? scopedVolumeName(project.slug, source.source)
          : migrationTargetVolume(project.slug, source.source, input.managedTarget, action)
        : migrationTargetPath(project.id, source.source, input.managedTarget);
      await add(service.name, source, handle, source.type, dest, action);
    }
  }
  if (!input.sameServer) for (const path of input.customPaths) {
    const handle = dataHandle(project.id, project.slug, "extra", path.source);
    const source = (await sourceExecutor.listSources(handle)).find(item => item.type === "bind");
    if (!source) throw new Error(`Could not resolve the additional path ${path.source}`);
    await add("extra", source, handle, "path", migrationTargetPath(project.id, path.dest, input.managedTarget));
  }

  const unique = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) {
    const { item } = candidate;
    const key = `${item.kind === "volume" ? "volume" : "path"}:${posix.normalize(item.dest)}`;
    const previous = unique.get(key);
    if (previous && (previous.item.source !== item.source || previous.action !== candidate.action))
      throw new Error(`Two different transfers write to ${item.dest}; choose separate destinations`);
    if (!previous) unique.set(key, candidate);
  }
  // Overlapping directory destinations are concurrent writers too.
  const paths = [...unique.values()].filter(({ item }) => item.kind !== "volume");
  for (const [index, { item }] of paths.entries()) for (const { item: other } of paths.slice(index + 1)) {
    const a = posix.normalize(item.dest), b = posix.normalize(other.dest);
    if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
      throw new Error(`Overlapping destinations ${a} and ${b}; import each directory only once`);
  }

  const plan: MigrationDataPlan = { items: [], createdVolumes: [], managedPaths: [] };
  for (const { item, action } of unique.values()) {
    if (item.kind === "volume") {
      let existing;
      try { existing = await input.targetRuntime.docker.getVolume(item.dest).inspect(); }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      if (existing && input.managedTarget && existing.Labels?.["openship.project"] !== project.id)
        throw new AppError("A target volume belongs to another project", 409, "CLOUD_VOLUME_CONFLICT");
      if (action === "keep") {
        if (!existing) throw new Error(`Cannot keep ${item.dest}: the target volume no longer exists`);
        input.log(`${item.dest}: keeping the existing target data`);
        continue;
      }
      if (input.sameServer && item.source === item.dest)
        throw new Error(`Cannot copy ${item.source} onto itself`);
      // Even 'clone' must check its final name. Never inherit consent from a
      // different volume or infer ownership from a slug prefix.
      const conflict = existing ? await probeOneVolume(targetExecutor, item.dst.handle, item.dst.sourceId, input.log) : null;
      if (conflict && action !== "override") {
        const users = existing?.Labels?.["openship.project"] === project.id && action !== "clone"
          ? await input.targetRuntime.docker.listContainers({ all: true, filters: { volume: [item.dest] } }) : null;
        if (!users || users.length || conflict === "unknown")
          throw new Error(`Target volume ${item.dest} ${conflict === "unknown" ? "could not be verified" : "already contains data"}. Review its conflict choice before importing.`);
        input.log(`${item.dest}: replacing unused data owned by this project`);
      }
      if (!existing) plan.createdVolumes.push(item.dest);
    } else {
      if (!targetExecutor.probeVolume) throw new Error(`Cannot verify destination ${item.dest}`);
      const state = await targetExecutor.probeVolume(item.dst.handle, item.dst.sourceId);
      if (state.exists && !state.empty)
        throw new Error(`Target path ${item.dest} already contains data. Choose an empty destination before importing.`);
      if (input.managedTarget && !state.exists) plan.managedPaths.push(item.dest);
    }
    plan.items.push(item);
  }
  return plan;
}

/** Reserve volume ownership before either rsync or the stream helper writes. */
export async function prepareMigrationVolumes(input: {
  runtime: DockerRuntime; projectId: string; runId?: string;
  plan: MigrationDataPlan; managed: boolean;
}) {
  for (const name of input.plan.createdVolumes) {
    await input.runtime.docker.createVolume({ Name: name, Labels: {
      "openship.project": input.projectId, ...(input.runId ? { "openship.migration": input.runId } : {}),
    } });
    const volume = await input.runtime.docker.getVolume(name).inspect();
    if (volume.Labels?.["openship.project"] !== input.projectId ||
        (input.runId && volume.Labels?.["openship.migration"] !== input.runId))
      throw new Error(`Target volume ${name} was created by another operation`);
  }
  if (input.managed) for (const item of input.plan.items.filter(item => item.kind === "volume"))
    await ensureCloudProjectVolume(input.runtime.docker, item.dest, input.projectId);
}

export async function transferMigrationItem(item: MigrationDataItem, input: {
  link?: DirectLink | null; mode?: TransferMode; compression?: TransferCompression;
  signal?: AbortSignal; log: (message: string) => void; onProgress?: (bytes: number) => void;
}) {
  input.signal?.throwIfAborted();
  if (input.link) {
    if (item.kind === "volume") await input.link.transferVolume(item.source, input.onProgress, item.dest);
    else await input.link.transferPath(item.source, item.dest, input.onProgress);
  } else {
    const result = await transferVolume(item.src, item.dst, { mode: input.mode,
      compression: input.compression, signal: input.signal, clearTarget: true,
      log: input.log, onProgress: input.onProgress });
    input.onProgress?.(result.bytesMoved);
  }
}
