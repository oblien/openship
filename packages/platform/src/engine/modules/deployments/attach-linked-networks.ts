/**
 * Both deployment paths attach consumers to the networks of their linked services.
 * Service links use an isolated network and stable DNS alias per source service;
 * older project links retain their project network. Service links fail the deploy
 * if networking cannot be established. Legacy links remain advisory.
 */
import { findProjectDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos } from "@repo/db";

import type { RuntimeAdapter } from "@repo/adapters";
import { ensureSharedServiceNetwork, sharedServiceNetwork } from "../projects/shared-service-network";
import { privateConnectionError } from "../projects/project-connection.service";
import { usesPrivateNetwork } from "../projects/project-connection.util";

type AttachRuntime = Pick<RuntimeAdapter, "attachToExternalNetworks"> & Partial<RuntimeAdapter>;

/** Docker network name for a project slug — the source app's private network. */
export function linkedNetworkName(slug: string): string {
  return `openship-${slug}`;
}

export async function attachLinkedNetworks(
  projectId: string,
  runtime: AttachRuntime,
  log?: (message: string, level?: "info" | "warn") => void,
  deploymentId?: string,
): Promise<void> {
  if (!runtime.attachToExternalNetworks) return; // runtime can't join external nets (cloud)
  let hasServiceLinks = false;
  try {
    const links = await repos.projectConnection.listByTarget(projectId);
    hasServiceLinks = links.some(link => usesPrivateNetwork(link) && !!link.sourceServiceId);
    const nets: string[] = [];
    for (const link of links) {
      if (!usesPrivateNetwork(link)) continue;
      const src = await repos.project.findById(link.sourceProjectId);
      if (src && link.sourceServiceId) {
        const target = await repos.project.findById(projectId);
        if (!target || src.organizationId !== target.organizationId) throw new Error("Invalid shared service connection.");
        const error = await privateConnectionError(src, deploymentId ? { ...target, activeDeploymentId: deploymentId } : target);
        if (error) throw new Error(error);
        await ensureSharedServiceNetwork(src, link.sourceServiceId, runtime as RuntimeAdapter);
        nets.push(sharedServiceNetwork(link.sourceServiceId));
      } else if (src?.slug) nets.push(linkedNetworkName(src.slug));
    }
    const ownNetworks: string[] = [];
    if (runtime.joinServiceGroupContainers) {
      const outgoing = await repos.projectConnection.listBySource(projectId);
      hasServiceLinks ||= outgoing.some(link => usesPrivateNetwork(link) && !!link.sourceServiceId);
      const source = await repos.project.findById(projectId);
      if (source) for (const serviceId of new Set(outgoing.filter(usesPrivateNetwork).map(link => link.sourceServiceId).filter((id): id is string => !!id))) {
        await ensureSharedServiceNetwork(source, serviceId, runtime as RuntimeAdapter, deploymentId);
        ownNetworks.push(sharedServiceNetwork(serviceId));
      }
    }
    if (nets.length > 0 || runtime.joinServiceGroupContainers) {
      /**
       * Name this project's containers EXPLICITLY as well as by label.
       *
       * `attachToExternalNetworks` filters on `openship.project=<id>`, and an ADOPTED
       * (in-place migrated) container keeps its ORIGINAL labels — labels are immutable, which
       * is why the migration has its own id-keyed joiner at all. So for a migrated consumer
       * the label match found nothing: the alias (`db:5432`) went into the env and the
       * container was never joined to the source app's network, so the connection failed to
       * resolve while the UI reported success. Stored container ids are the identity the READ
       * paths already use (services/live-state.ts).
       */
      const project = await repos.project.findById(projectId).catch(() => null);
      const currentDeploymentId = deploymentId ?? project?.activeDeploymentId;
      const deployment = project && currentDeploymentId
        ? await findProjectDeployment(project, currentDeploymentId).catch(() => undefined)
        : undefined;
      const stored = deployment
        ? (await repos.service.listByDeployment(deployment.id).catch(() => []))
            .map((row) => row.containerId)
            .filter((id): id is string => !!id)
        : [];
      const networks = [...new Set(nets)];
      if (runtime.joinServiceGroupContainers) {
        await runtime.attachToExternalNetworks(projectId, networks, stored, {
          // A user-named project such as "shared-tools" can have this prefix too.
          // Always keep its own project network while removing revoked links.
          prunePrefix: "openship-shared-", retain: [...ownNetworks, ...(project?.slug ? [linkedNetworkName(project.slug)] : [])],
          strict: hasServiceLinks,
        });
      } else await runtime.attachToExternalNetworks(projectId, networks, stored);
      if (nets.length) log?.(`Attached to ${networks.length} connected service network(s).`, "info");
    }
  } catch (err) {
    if (hasServiceLinks) throw err;
    log?.(
      `Warning: could not attach linked service networks: ${err instanceof Error ? err.message : String(err)}`,
      "warn",
    );
  }
}
