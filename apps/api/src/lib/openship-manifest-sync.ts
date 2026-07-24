/**
 * Manifest SYNC orchestration — the single place that decides WHEN and WHAT to
 * mirror into a server's `.openship/manifest.json`, gathering the structural
 * project data from the DB.
 *
 * Layering (no logic duplicated across modules):
 *   openship-server-store  → the `.openship/` folder + atomic file I/O
 *   openship-manifest      → the manifest schema + read/write/upsert/remove
 *   openship-manifest-sync → THIS: gate + gather-from-DB + call the above
 *
 * Plan B for a lost orchestrator. DESKTOP-ONLY by design: in VPS/self-hosted
 * mode the orchestrator DB lives on a durable, backup-able box, so a server-side
 * mirror is unnecessary — every function here no-ops outside desktop mode.
 */

import type { CommandExecutor } from "@repo/adapters";
import { repos, dumpSubgraph, type Project, type Deployment } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { resolveDeploymentPlatform, type DeploymentMeta } from "./deployment-runtime";
import {
  upsertProjectIntoManifest,
  removeProjectFromManifest,
  writeProjectSnapshot,
  removeProjectSnapshot,
  type ManifestProjectEntry,
} from "./openship-manifest";

/**
 * FINAL STEP of a successful server deploy: mirror this project to the target
 * server so a fresh orchestrator can recover it after a lost/reset DB. Writes
 * TWO artifacts (NO secrets):
 *   - `.openship/manifest.json`   — lightweight structural INDEX (read on scan)
 *   - `.openship/snapshot-<id>.json` — the full project subgraph dump, for a
 *      FAITHFUL `restoreSubgraph` on re-import.
 *
 * Runs for ANY server deploy (not just desktop) so CLI / self-hosted deploys are
 * recoverable too. Best-effort: never throws — a server-write hiccup can't fail
 * the deploy (the orchestrator DB is always canonical). Each artifact is written
 * independently so one failing doesn't skip the other.
 */
export async function syncProjectToServerManifest(input: {
  /** Kept for call-site compatibility; the mirror is no longer desktop-gated. */
  baseTarget?: string;
  effectiveTarget: string;
  serverId: string | null;
  executor: CommandExecutor | null;
  project: Project;
  deployment: Deployment;
  containerId: string;
  log?: (message: string) => void;
}): Promise<void> {
  const { effectiveTarget, serverId, executor, project, deployment, containerId, log } = input;
  if (effectiveTarget !== "server" || !serverId || !executor) {
    return;
  }
  try {
    const domainRows = await repos.domain.listByProject(project.id).catch(() => []);
    const app = await repos.projectGroup.findById(project.groupId).catch(() => null);
    const meta = (deployment.meta ?? {}) as { runtimeMode?: string };
    const entry: ManifestProjectEntry = {
      id: project.id,
      slug: project.slug,
      name: project.name,
      organizationId: project.organizationId,
      groupId: project.groupId,
      appName: app?.name ?? project.name,
      appSlug: app?.slug ?? null,
      gitProvider: project.gitProvider,
      gitOwner: project.gitOwner,
      gitRepo: project.gitRepo,
      gitBranch: project.gitBranch,
      runtimeMode: meta.runtimeMode ?? null,
      autoDeploy: project.autoDeploy,
      environmentSlug: project.environmentSlug,
      domains: domainRows.map((d) => d.hostname),
      deployment: {
        id: deployment.id,
        containerId,
        imageRef: deployment.imageRef ?? null,
        status: "ready",
        meta: (deployment.meta ?? null) as Record<string, unknown> | null,
      },
      updatedAt: new Date().toISOString(),
    };
    await upsertProjectIntoManifest(executor, entry);
    log?.("Synced project to server .openship/manifest.json (recovery index)");
  } catch (err) {
    log?.(`Warning: .openship manifest sync failed (non-fatal): ${safeErrorMessage(err)}`);
  }

  // Full secret-free subgraph dump — the faithful-restore payload. Independent
  // best-effort so a large-dump hiccup never blocks the manifest (or the deploy).
  try {
    const dump = await dumpSubgraph({ kind: "project", projectId: project.id }, { stripEncrypted: true });
    await writeProjectSnapshot(executor, project.id, dump);
    log?.("Wrote server .openship project snapshot (faithful recovery restore)");
  } catch (err) {
    log?.(`Warning: .openship project snapshot write failed (non-fatal): ${safeErrorMessage(err)}`);
  }
}

/**
 * Drop this project's recovery artifacts (manifest entry + snapshot) from every
 * server it was deployed to (called on teardown) so a later recover-from-server
 * scan doesn't re-list a deleted project. Runs for any server deploy (non-server
 * deploys carry no meta.serverId → skipped). Best-effort — the reconcile's
 * running-container cross-check is the real guard.
 */
export async function removeProjectFromServerManifests(project: Project): Promise<void> {
  let deps: Deployment[] = [];
  try {
    deps = (await repos.deployment.listByProject(project.id, { perPage: 1000 })).rows;
  } catch {
    return;
  }
  const seenServers = new Set<string>();
  for (const dep of deps) {
    const meta = (dep.meta ?? {}) as DeploymentMeta;
    if (!meta.serverId || seenServers.has(meta.serverId)) continue;
    seenServers.add(meta.serverId);
    try {
      const resolved = await resolveDeploymentPlatform(meta, {
        organizationId: dep.organizationId,
      });
      const exec = resolved.platform.executor;
      if (exec) {
        await removeProjectFromManifest(exec, project.id);
        await removeProjectSnapshot(exec, project.id).catch(() => {});
      }
    } catch {
      // Server unreachable — fine; the reconcile cross-check (no running
      // container → skip) prevents resurrecting the deleted project.
    }
  }
}
