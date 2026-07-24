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
import { safeErrorMessage, withTimeout } from "@repo/core";
import { repos } from "@repo/db";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import { readManifest, projectSnapshotExists, type ManifestProjectEntry } from "../../lib/openship-manifest";
import {
  reconcileStack,
  reconcileOpenshipProjects,
  isBuildHelper,
  type DiscoveredStack,
} from "./docker-reconcile";
import { scanProxyRoutes } from "./proxy-route-scan";

/** Openship project-id shape — used to reject crafted `openship.project` labels
 *  before they reach the remote snapshot probe (same shape migrate.service uses). */
const OPENSHIP_PROJECT_ID_RE = /^proj_[A-Za-z0-9]+$/;

export type {
  DiscoveredStack,
  DiscoveredService,
  DiscoveredVolumeMount,
  OpenshipProjectGroup,
} from "./docker-reconcile";
export { reconcileStack } from "./docker-reconcile";

// Cap the connect+reachability probe so a hung SSH docker forward can't leave the
// migration scan spinning on "Connecting to Docker…" forever (the reported bug).
const REACHABILITY_TIMEOUT_MS = 25_000;

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
  opts?: {
    /** "Flat Docker" mode: ignore `openship.*` labels entirely so Openship-managed
     *  deploy containers are adopted as PLAIN compose/standalone (no re-import,
     *  no snapshot restore). The one filter (`isOpenshipOwned`) is bypassed. */
    flatDocker?: boolean;
  },
): Promise<DiscoveredStack> {
  const step = (m: string) => onProgress?.(m);
  const flatDocker = opts?.flatDocker === true;
  step("Connecting to Docker…");
  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    // Surface the transport's detailed reachability diagnostic (socket path,
    // streamlocal/permission hints, remote `ls -ld` of the socket) instead of a
    // bare "not reachable" — ping() collapses that to a boolean and logs it away,
    // which is why a failed migrate showed no actionable reason.
    try {
      // Safety net on top of the transport's own streamlocal timeout: never let the
      // scan hang indefinitely on an unresponsive daemon/SSH forward — surface a
      // clear error (with the transport diagnostic) instead of a silent spinner.
      await withTimeout(
        rt.assertReachable(),
        REACHABILITY_TIMEOUT_MS,
        `timed out after ${REACHABILITY_TIMEOUT_MS / 1000}s connecting to the Docker daemon`,
      );
    } catch (err) {
      throw new Error(`Docker daemon is not reachable on this server. ${safeErrorMessage(err)}`);
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
    //
    // FLAT DOCKER mode ignores the openship.* namespace: every container (minus
    // transient build helpers) is a generic candidate, so Openship-managed
    // workloads adopt as plain compose/standalone — no managed set, no re-import.
    const isOpenshipOwned = (labels: Record<string, string>) =>
      Object.keys(labels).some((k) => k === "openship" || k.startsWith("openship."));
    const managed = flatDocker ? [] : containers.filter((c) => isOpenshipOwned(c.labels));
    const candidates = flatDocker
      ? containers.filter((c) => !isBuildHelper(c.labels))
      : containers.filter((c) => !isOpenshipOwned(c.labels));
    const managedApp = managed.filter(
      (c) => c.labels["openship.project"] && !isBuildHelper(c.labels),
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

    // Detect routes the server's existing (foreign) reverse proxy already serves,
    // indexed by published host port — so the wizard can surface each container's
    // current domain(s)+SSL. Own read-only SSH pass; self-catching (never fails
    // discovery). Skipped in flat mode is unnecessary — a foreign proxy is a
    // foreign proxy regardless of how we classify the app containers.
    step("Scanning existing reverse proxy…");
    const proxyRoutesByPort = await scanProxyRoutes(serverId);

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
    // SECURITY: `openship.project` is a container LABEL — attacker-controllable
    // via a malicious image's LABEL, inherited onto the container. It flows into
    // a remote root shell (`projectSnapshotExists` → `test -f …snapshot-<id>…`),
    // so validate the id shape BEFORE the probe; a crafted `x$(cmd)` label is
    // dropped here (belt-and-braces with the store's own quoting).
    const projectIds = [
      ...new Set(managedApp.map((c) => c.labels["openship.project"]!).filter((id) => id && OPENSHIP_PROJECT_ID_RE.test(id))),
    ];
    if (projectIds.length > 0) {
      step("Recovering Openship projects…");
      // One SSH session: read the manifest AND check which projects have a full
      // recovery snapshot (cheap `test -f`, no read — the dump is read only at
      // re-import time, for one project).
      const { manifestById, snapshotIds } = await sshManager
        .withExecutor(serverId, async (exec) => {
          const manifest = await readManifest(exec).catch(() => null);
          const snap = new Set<string>();
          await Promise.all(
            projectIds.map(async (id) => {
              if (await projectSnapshotExists(exec, id).catch(() => false)) snap.add(id);
            }),
          );
          return {
            manifestById: manifest
              ? new Map<string, ManifestProjectEntry>(manifest.projects.map((p) => [p.id, p]))
              : null,
            snapshotIds: snap,
          };
        })
        .catch(() => ({ manifestById: null, snapshotIds: new Set<string>() }));
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
        snapshotIds,
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
      proxyRoutesByPort,
    });
  } finally {
    await rt.dispose();
  }
}
