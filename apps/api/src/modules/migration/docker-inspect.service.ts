/**
 * Docker discovery for the "migrate an existing deployment" flow — the IO shell.
 *
 * Read-only. Points a DockerRuntime at a server's daemon over SSH, enumerates
 * every container/volume/network (label-agnostic — not just openship.*), reads
 * any docker-compose files those containers were started from, and hands the
 * raw data to the pure `reconcileStack` (docker-reconcile.ts) which merges it
 * into one normalized `DiscoveredStack`. Nothing here mutates the server.
 */

import type { DockerContainerDetail } from "@repo/adapters";
import { repos } from "@repo/db";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import { readManifest, type ManifestProjectEntry } from "../../lib/openship-manifest";
import {
  reconcileStack,
  reconcileOpenshipProjects,
  type DiscoveredStack,
} from "./docker-reconcile";

export type {
  DiscoveredStack,
  DiscoveredService,
  DiscoveredVolumeMount,
  OpenshipProjectGroup,
} from "./docker-reconcile";
export { reconcileStack } from "./docker-reconcile";

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Read + parse every compose file referenced by the discovered containers, in a
 * single pooled-SSH round of reads. Returns a service-name → declared map.
 */
async function readComposeDeclarations(
  serverId: string,
  groups: Map<string, DockerContainerDetail[]>,
): Promise<Map<string, ComposeService>> {
  // Resolve absolute compose paths (relative ones join the project working dir).
  const paths = new Set<string>();
  for (const details of groups.values()) {
    for (const d of details) {
      for (const raw of d.composeConfigFiles ?? []) {
        const abs = raw.startsWith("/")
          ? raw
          : `${(d.composeWorkingDir ?? "").replace(/\/$/, "")}/${raw}`;
        if (abs.startsWith("/")) paths.add(abs);
      }
    }
  }
  if (paths.size === 0) return new Map();

  const contents = await sshManager.withExecutor(serverId, async (executor) => {
    return Promise.all(
      [...paths].map(async (p) => {
        try {
          return [p, await executor.readFile(p)] as const;
        } catch {
          return [p, undefined] as const;
        }
      }),
    );
  });

  const declared = new Map<string, ComposeService>();
  for (const [, content] of contents) {
    if (!content) continue;
    try {
      for (const svc of parseComposeFile(content).services) {
        // First declaration wins; overrides across multiple files are rare and
        // reconciled against inspect truth anyway.
        if (!declared.has(svc.name)) declared.set(svc.name, svc);
      }
    } catch {
      // Invalid YAML — skip; inspect data still reconstructs the service.
    }
  }
  return declared;
}

export async function discoverServerStack(
  serverId: string,
  organizationId: string,
  onProgress?: (message: string) => void,
): Promise<DiscoveredStack> {
  const step = (m: string) => onProgress?.(m);
  step("Connecting to Docker…");
  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    if (!(await rt.ping())) {
      throw new Error("Docker daemon is not reachable on this server.");
    }

    step("Listing containers, volumes and networks…");
    const [containers, volumes, networks] = await Promise.all([
      rt.listAllContainers(),
      rt.listAllVolumes(),
      rt.listAllNetworks(),
    ]);

    // Split by ownership. GENERIC candidates (no openship.* label) feed the
    // normal adopt grid. OPENSHIP-owned deploy containers are recovered as their
    // own projects (re-import) — build helpers (`openship.build`) are neither.
    const isOpenshipOwned = (labels: Record<string, string>) =>
      Object.keys(labels).some((k) => k === "openship" || k.startsWith("openship."));
    const managed = containers.filter((c) => isOpenshipOwned(c.labels));
    const candidates = containers.filter((c) => !isOpenshipOwned(c.labels));
    const managedApp = managed.filter(
      (c) => c.labels["openship.project"] && !c.labels["openship.build"],
    );

    step(`Inspecting ${candidates.length} container(s)…`);
    const [details, managedDetails] = await Promise.all([
      mapLimit(candidates, 5, (c) => rt.inspectContainer(c.id)).then((d) =>
        d.filter((x): x is DockerContainerDetail => x !== null),
      ),
      mapLimit(managedApp, 5, (c) => rt.inspectContainer(c.id)).then((d) =>
        d.filter((x): x is DockerContainerDetail => x !== null),
      ),
    ]);

    // Group by compose project (standalone containers key on "") for the
    // compose-file reads; reconciliation itself is pure (see reconcileStack).
    const groups = new Map<string, DockerContainerDetail[]>();
    for (const d of details) {
      const key = d.composeProject ?? "";
      const list = groups.get(key) ?? [];
      list.push(d);
      groups.set(key, list);
    }

    step("Reading compose files…");
    const declared = await readComposeDeclarations(serverId, groups);

    // Fetch each distinct image's baked-in env once (candidates AND openship
    // containers), so discovery can subtract image defaults and import only the
    // vars the operator actually set.
    const uniqueImages = [
      ...new Set([...details, ...managedDetails].map((d) => d.image).filter(Boolean)),
    ];
    const imageInfoPairs = await mapLimit(uniqueImages, 4, async (ref) => {
      const [env, cmd] = await Promise.all([rt.inspectImageEnv(ref), rt.inspectImageCmd(ref)]);
      return [ref, { env: new Set(env), cmd }] as const;
    });
    const imageDefaults = new Map(imageInfoPairs.map(([ref, v]) => [ref, v.env]));
    const imageCmds = new Map(imageInfoPairs.map(([ref, v]) => [ref, v.cmd]));

    // Recover Openship projects: read the on-server manifest (rich, faithful
    // recipe) and cross-reference each openship.project id against THIS org's DB.
    // Present here = genuinely managed → counted; absent = orphaned → re-importable.
    let openshipProjects: DiscoveredStack["openshipProjects"] = [];
    let alreadyManaged = 0;
    const projectIds = [...new Set(managedApp.map((c) => c.labels["openship.project"]!).filter(Boolean))];
    if (projectIds.length > 0) {
      step("Recovering Openship projects…");
      const manifest = await sshManager
        .withExecutor(serverId, (exec) => readManifest(exec))
        .catch(() => null);
      const manifestById = manifest
        ? new Map<string, ManifestProjectEntry>(manifest.projects.map((p) => [p.id, p]))
        : null;
      const knownHereIds = new Set<string>();
      await Promise.all(
        projectIds.map(async (id) => {
          const row = await repos.project.findByIdInOrganization(id, organizationId);
          if (row) knownHereIds.add(id);
        }),
      );
      openshipProjects = reconcileOpenshipProjects({
        managedDetails,
        manifestById,
        knownHereIds,
        imageDefaults,
        imageCmds,
      });
      alreadyManaged = managedApp.filter((c) => knownHereIds.has(c.labels["openship.project"]!)).length;
    }

    return reconcileStack({
      serverId,
      details,
      volumes,
      networks,
      declared,
      alreadyManaged,
      imageDefaults,
      imageCmds,
      openshipProjects,
    });
  } finally {
    await rt.dispose();
  }
}
