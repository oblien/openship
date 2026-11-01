import { repos, type Deployment, type OrphanedResource, type Project } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import type { ResolvedDeploymentPlatform } from "./deployment-runtime";
import { connectionHostPortTargetKey } from "./host-port-target";
import { orphanCleanupLock } from "./orphan-cleanup-lock";
import { withLiveProjectRuntimeMutation } from "./project-runtime-lock";

/**
 * A recreated project can already be serving on its predecessor's named Docker
 * network. GC cannot remove that network, so its dependent route reservations
 * never clear. Transfer only the current project's configured routes on the same
 * physical target, after proving the old owner is gone and the network is reused.
 * No vhost, certificate, container or network is removed during this handoff.
 *
 * Lock order is project → orphan cleanup → host-port target. Call before taking
 * a host-port target lock; GC uses that same order without taking a project lock.
 */
export async function recoverProjectRouteCleanup(input: {
  project: Project;
  deployment: Deployment;
  resolved: ResolvedDeploymentPlatform;
  hostnames: string[];
  onLog?: (message: string) => void;
}): Promise<void> {
  const { project, deployment, resolved } = input;
  const wanted = new Set(input.hostnames.map((hostname) => hostname.toLowerCase()));
  if (!wanted.size || !resolved.hostPortTarget || resolved.effectiveTarget === "cloud") return;
  const isCandidate = (orphan: OrphanedResource) =>
    orphan.resourceType === "route" &&
    wanted.has(orphan.ref.toLowerCase()) &&
    orphan.organizationId === project.organizationId &&
    !!orphan.projectId &&
    orphan.projectId !== project.id;
  if (!(await repos.orphanedResource.listAll()).some(isCandidate)) return;

  await withLiveProjectRuntimeMutation(project.id, async (current) => {
    if (
      current.organizationId !== project.organizationId ||
      current.activeDeploymentId !== deployment.id ||
      deployment.projectId !== current.id ||
      deployment.organizationId !== current.organizationId
    )
      return;

    await orphanCleanupLock.run(async () => {
      // Re-read AFTER acquiring GC's lock. A queued sweep must likewise take its
      // snapshot under the lock so it cannot replay a checkpoint we retire here.
      const orphans = await repos.orphanedResource.listAll();
      const candidates = orphans.filter(isCandidate);
      if (!candidates.length) return;
      const targetKeys = new Set<string>([resolved.hostPortTarget!.targetKey]);
      if (resolved.serverId) {
        const server = await repos.server.getInOrganization(
          resolved.serverId,
          current.organizationId,
        );
        if (server?.sshHost && !server.workspaceId) targetKeys.add(server.isLocal ? "local" : connectionHostPortTargetKey({ ...server, sshHost: server.sshHost }));
      }
      // A mutable server id (or an absent identity) cannot authorize a handoff.
      // Include only the current target's immutable machine/connection identities.
      const onTarget = (orphan: OrphanedResource) =>
        !!orphan.targetKey &&
        targetKeys.has(orphan.targetKey) &&
        orphan.runtimeMode === resolved.runtimeMode;
      // This lookup deliberately includes soft-deleted projects: their teardown
      // or restoration can still run, so only a fully removed owner is eligible.
      const oldOwners = new Set(
        (
          await repos.project.listNamesByIds([
            ...new Set(candidates.map((orphan) => orphan.projectId!)),
          ])
        ).map((owner) => owner.id),
      );
      const eligible = candidates.filter(
        (orphan) => onTarget(orphan) && !oldOwners.has(orphan.projectId!),
      );
      if (!eligible.length) return;

      const release = new Map<string, OrphanedResource>();
      for (const orphan of eligible) {
        const owner = await repos.domain.findByHostname(orphan.ref);
        if (owner && owner.projectId !== current.id) continue;
        // A hostname can have checkpoints on several targets or from several
        // owners. Recover it only when every remaining reservation is accounted for.
        if (
          orphans.some(
            (other) =>
              other.resourceType === "route" &&
              other.ref.toLowerCase() === orphan.ref.toLowerCase() &&
              !(other.projectId === current.id || eligible.some((entry) => entry.id === other.id)),
          )
        )
          continue;
        const related = orphans.filter(
          (other) =>
            other.projectId === orphan.projectId &&
            other.organizationId === current.organizationId &&
            (onTarget(other) || (!other.targetKey && other.serverId === orphan.serverId)),
        );
        // Never retire a route in front of outstanding destructive workload or
        // volume cleanup. A network reused by this project is the recoverable case.
        if (
          related.some(
            (other) => !["route", "network", "host_port_claims"].includes(other.resourceType),
          )
        )
          continue;
        const networks = related.filter((other) => other.resourceType === "network");
        if (networks.some((network) => !onTarget(network) || network.ref !== current.slug))
          continue;
        for (const network of networks) {
          release.set(network.id, network);
        }
        release.set(orphan.id, orphan);
      }
      if (!release.size) return;

      if ([...release.values()].some((orphan) => orphan.resourceType === "network")) {
        const runtime = resolved.platform.runtime;
        if (!(runtime instanceof DockerRuntime)) return;
        const services = await repos.service.listByProject(current.id);
        const serviceIds = new Set(services.map((service) => service.id));
        const liveRows = await repos.service.listByDeployment(deployment.id);
        const containerIds = new Set(
          liveRows.filter((row) => serviceIds.has(row.serviceId)).map((row) => row.containerId),
        );
        if (deployment.containerId) containerIds.add(deployment.containerId);
        let networkConfirmed = false;
        for (const containerId of containerIds) {
          if (!containerId) continue;
          const container = await runtime.inspectContainer(containerId);
          if (container?.networks.includes(`openship-${current.slug}`)) {
            networkConfirmed = true;
            break;
          }
        }
        if (!networkConfirmed) return;
      }

      // Current project teardown inventories these configured routes and its
      // network itself. Retire the predecessor's intent together; keeping its
      // network checkpoint could destroy this project's network after a stop.
      await repos.orphanedResource.deleteMany([...release.keys()]);
      for (const orphan of release.values()) {
        if (orphan.resourceType === "route") {
          input.onLog?.(
            `Recovered ${orphan.ref} from previous-project cleanup; keeping its existing route and certificate.`,
          );
        }
      }
    });
  });
}
